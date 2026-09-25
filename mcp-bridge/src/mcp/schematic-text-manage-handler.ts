import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';

type Action = 'read' | 'create' | 'delete';

interface TextState {
	primitiveId: string;
	x: number;
	y: number;
	content: string;
	rotation: number;
	textColor: string | null;
	fontName: string | null;
	fontSize: number | null;
	bold: boolean;
	italic: boolean;
	underLine: boolean;
	alignMode: number;
}

interface TextApi extends Record<string, unknown> {
	getAll: () => Promise<unknown>;
	getAllPrimitiveId: () => Promise<unknown>;
	create?: (...args: unknown[]) => Promise<unknown>;
	delete?: (id: string) => Promise<unknown>;
}

const SCOPE = 'current_schematic_page';
const FIELDS = new Set(['x', 'y', 'content', 'rotation', 'textColor', 'fontName', 'fontSize', 'bold', 'italic', 'underLine']);
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;

function requiredId(value: unknown): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError('primitiveId must be a non-empty string.');
	return value.trim();
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${field} must be a finite number.`);
	return value;
}

function state(raw: unknown, name: string): unknown {
	const getter = (raw as Record<string, unknown> | null)?.[`getState_${name}`];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA schematic text getState_${name} is unavailable.`);
	return getter.call(raw);
}

function styleFlag(value: unknown, name: string): boolean {
	// EDA 3.2 returns null for an unset text style; the editor renders it as false.
	if (value === null)
		return false;
	if (typeof value !== 'boolean')
		throw new TypeError(`EDA schematic text ${name} state is invalid.`);
	return value;
}

function readText(raw: unknown): TextState {
	const text: TextState = {
		primitiveId: requiredId(state(raw, 'PrimitiveId')),
		x: finiteNumber(state(raw, 'X'), 'EDA x'),
		y: finiteNumber(state(raw, 'Y'), 'EDA y'),
		content: state(raw, 'Content') as string,
		rotation: finiteNumber(state(raw, 'Rotation'), 'EDA rotation'),
		textColor: state(raw, 'TextColor') as string | null,
		fontName: state(raw, 'FontName') as string | null,
		fontSize: state(raw, 'FontSize') as number | null,
		bold: styleFlag(state(raw, 'Bold'), 'bold'),
		italic: styleFlag(state(raw, 'Italic'), 'italic'),
		underLine: styleFlag(state(raw, 'UnderLine'), 'underLine'),
		alignMode: finiteNumber(state(raw, 'AlignMode'), 'EDA alignMode'),
	};
	const invalidFields: string[] = [];
	function check(field: string, item: unknown, valid: boolean): void {
		if (!valid)
			invalidFields.push(`${field}=${item === null ? 'null' : `${typeof item}(${String(item)})`}`);
	}
	check('content', text.content, typeof text.content === 'string');
	check('textColor', text.textColor, text.textColor === null || typeof text.textColor === 'string');
	check('fontName', text.fontName, text.fontName === null || typeof text.fontName === 'string');
	check('fontSize', text.fontSize, text.fontSize === null || (typeof text.fontSize === 'number' && Number.isFinite(text.fontSize)));
	if (invalidFields.length > 0)
		throw new TypeError(`EDA schematic text state is incomplete: ${invalidFields.join(', ')}.`);
	return text;
}

function textApi(runtime: Record<string, unknown>): TextApi {
	const api = runtime.sch_PrimitiveText;
	if (!isPlainObjectRecord(api) || ['getAll', 'getAllPrimitiveId'].some(name => typeof api[name] !== 'function'))
		throw new TypeError('EDA sch_PrimitiveText read API is unavailable. Open a schematic page first.');
	return api as TextApi;
}

async function pageUuid(runtime: Record<string, unknown>): Promise<string> {
	const schematic = runtime.dmt_Schematic;
	const select = runtime.dmt_SelectControl;
	if (!isPlainObjectRecord(schematic) || typeof schematic.getCurrentSchematicPageInfo !== 'function'
		|| !isPlainObjectRecord(select) || typeof select.getCurrentDocumentInfo !== 'function') {
		throw new Error('Current schematic page and editor document cannot be confirmed.');
	}
	const [page, document] = await Promise.all([schematic.getCurrentSchematicPageInfo(), select.getCurrentDocumentInfo()]);
	if (!isPlainObjectRecord(page) || !isPlainObjectRecord(document)
		|| typeof page.uuid !== 'string' || !page.uuid.trim() || page.uuid !== document.uuid) {
		throw new Error('The active schematic page and editor document are not synchronized; retry after page load.');
	}
	return page.uuid.trim();
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await pageUuid(runtime) !== expected)
		throw new Error('The active schematic page changed during the text operation.');
}

async function allTexts(runtime: Record<string, unknown>, api: TextApi, page: string): Promise<TextState[]> {
	const [raw, rawIds] = await Promise.all([api.getAll(), api.getAllPrimitiveId()]);
	if (!Array.isArray(raw) || !Array.isArray(rawIds) || rawIds.some(id => typeof id !== 'string' || !id.trim()))
		throw new TypeError('EDA sch_PrimitiveText did not return complete text and ID arrays.');
	const texts = raw.map(readText);
	const ids = new Set(rawIds as string[]);
	if (texts.length !== ids.size || texts.some(item => !ids.has(item.primitiveId)))
		throw new Error('Current-page schematic text list changed during read; retry after page load.');
	await assertSamePage(runtime, page);
	return preserveBoundedArray(texts);
}

async function oneText(runtime: Record<string, unknown>, api: TextApi, page: string, id: string): Promise<TextState | undefined> {
	return (await allTexts(runtime, api, page)).find(text => text.primitiveId === id);
}

function requestedProperty(value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	const property: Record<string, unknown> = {};
	for (const [field, item] of Object.entries(value)) {
		if (field === 'alignMode')
			throw new TypeError('The current EDA API cannot reliably write schematic text alignMode.');
		if (!FIELDS.has(field))
			throw new TypeError(`Unsupported schematic text property: ${field}.`);
		if (field === 'x' || field === 'y') {
			property[field] = finiteNumber(item, field);
		}
		else if (field === 'rotation') {
			if (item !== 0 && item !== 90 && item !== 180 && item !== 270)
				throw new TypeError('rotation must be 0, 90, 180, or 270.');
			property[field] = item;
		}
		else if (field === 'fontSize') {
			if (item !== null && finiteNumber(item, field) <= 0)
				throw new TypeError('fontSize must be positive or null.');
			property[field] = item;
		}
		else if (field === 'bold' || field === 'italic' || field === 'underLine') {
			if (typeof item !== 'boolean')
				throw new TypeError(`${field} must be a boolean.`);
			property[field] = item;
		}
		else {
			if (typeof item !== 'string' && !(item === null && (field === 'textColor' || field === 'fontName')))
				throw new TypeError(`${field} must be a string${field === 'content' ? '' : ' or null'}.`);
			property[field] = item;
		}
	}
	return property;
}

function matches(actual: TextState, requested: Record<string, unknown>): boolean {
	return Object.entries(requested).every(([field, wanted]) => {
		const observed = actual[field as keyof TextState];
		return typeof observed === 'number' && typeof wanted === 'number'
			? Math.abs(observed - wanted) <= 1e-6
			: observed === wanted;
	});
}

function unknownWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>, nativeCallSettled: boolean): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!nativeCallSettled && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action, scope: SCOPE, ...context, reason: nativeCallSettled ? 'post_write_readback_failed' : 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled };
}

export async function handleSchematicTextManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_text_manage payload must be an object.');
	if (payload.action === 'modify')
		throw new TypeError('The current EDA API changes schematic text alignment during modification; modify is unavailable.');
	const action = payload.action as Action;
	if (!['read', 'create', 'delete'].includes(action))
		throw new TypeError('action must be read, create, or delete.');
	const primitiveId = payload.primitiveId === undefined ? undefined : requiredId(payload.primitiveId);
	if (action === 'delete' && !primitiveId)
		throw new TypeError('primitiveId is required.');
	if (action === 'create' && payload.alignMode !== undefined)
		throw new TypeError('The current EDA API cannot reliably write schematic text alignMode.');
	const create = action === 'create'
		? requestedProperty(Object.fromEntries([...FIELDS].filter(field => payload[field] !== undefined).map(field => [field, payload[field]])))
		: undefined;
	if (create && (create.x === undefined || create.y === undefined || create.content === undefined))
		throw new TypeError('x, y, and content are required for schematic text creation.');
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const api = textApi(runtime);
	const page = await pageUuid(runtime);
	if (action === 'read') {
		if (primitiveId) {
			const text = await oneText(runtime, api, page, primitiveId);
			return { ok: true, action, scope: SCOPE, pageUuid: page, primitiveId, found: text !== undefined, text: text ?? null };
		}
		const texts = await allTexts(runtime, api, page);
		return { ok: true, action, scope: SCOPE, pageUuid: page, complete: true, textCount: texts.length, texts };
	}
	if (typeof api[action] !== 'function')
		throw new TypeError(`EDA sch_PrimitiveText.${action} is unavailable.`);
	const before = action === 'delete' ? await oneText(runtime, api, page, primitiveId!) : undefined;
	if (action === 'delete' && !before)
		throw new TypeError(`Schematic text ${primitiveId} does not exist on the current page.`);
	const beforeIds = action === 'create' ? (await allTexts(runtime, api, page)).map(item => item.primitiveId) : undefined;
	const context: Record<string, unknown> = { pageUuid: page, ...(primitiveId ? { primitiveId } : {}) };
	await assertSamePage(runtime, page);
	let nativeResult: unknown;
	try {
		if (action === 'create') {
			nativeResult = await api.create!.call(api, create!.x, create!.y, create!.content, create!.rotation ?? 0, create!.textColor ?? null, create!.fontName ?? null, create!.fontSize ?? null, create!.bold ?? false, create!.italic ?? false, create!.underLine ?? false, create!.alignMode);
		}
		else {
			nativeResult = await api.delete!.call(api, primitiveId!);
		}
	}
	catch (error: unknown) { return unknownWrite(action, error, context, false); }
	try {
		await assertSamePage(runtime, page);
		if (action === 'create') {
			const texts = await allTexts(runtime, api, page);
			const added = texts.filter(item => !beforeIds!.includes(item.primitiveId));
			const returnedId = nativeResult == null ? undefined : requiredId(state(nativeResult, 'PrimitiveId'));
			const created = returnedId ? added.find(item => item.primitiveId === returnedId) : added.length === 1 ? added[0] : undefined;
			if (!created || added.length !== 1 || !matches(created, create!))
				throw new Error('EDA did not read back exactly one matching new schematic text.');
			return { ok: true, action, scope: SCOPE, pageUuid: page, primitiveId: created.primitiveId, text: created, verified: true };
		}
		const observed = await oneText(runtime, api, page, primitiveId!);
		if (nativeResult === false || observed)
			throw new Error('EDA schematic text still exists after delete.');
		return { ok: true, action, scope: SCOPE, pageUuid: page, primitiveId, deleted: true, verified: true };
	}
	catch (error: unknown) { return unknownWrite(action, error, context, true); }
}
