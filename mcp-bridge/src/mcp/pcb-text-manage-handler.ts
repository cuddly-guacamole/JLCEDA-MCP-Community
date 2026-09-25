import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';

type Action = 'read' | 'create' | 'modify' | 'delete';
type Kind = 'string' | 'attribute';
interface TextState {
	primitiveId: string;
	layer: number;
	x: number | null;
	y: number | null;
	fontFamily: string;
	fontSize: number;
	lineWidth: number;
	alignMode: number;
	rotation: number;
	reverse: boolean;
	expansion: number;
	mirror: boolean;
	primitiveLock: boolean;
	text?: string;
	parentPrimitiveId?: string;
	key?: string;
	value?: string;
	keyVisible?: boolean;
	valueVisible?: boolean;
}

const SCOPE = 'current_pcb_page';
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const IMAGE_LAYERS = new Set([1, 2, 3, 4, 5, 6, 9, 10, 13, 14, 56]);
const COMMON_FIELDS = new Set(['layer', 'x', 'y', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock']);
const STRING_FIELDS = new Set([...COMMON_FIELDS, 'text']);
const ATTRIBUTE_FIELDS = new Set([...COMMON_FIELDS, 'key', 'value', 'keyVisible', 'valueVisible']);
const DEFAULT_STRING_STYLE = { fontFamily: 'default', fontSize: 45, lineWidth: 6, alignMode: 3, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false };

function requiredId(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${field} must be a finite number.`);
	return value;
}

function imageLayer(value: unknown): number {
	const layer = finiteNumber(value, 'layer');
	if (!Number.isInteger(layer) || (!IMAGE_LAYERS.has(layer) && !(layer >= 15 && layer <= 44) && !(layer >= 71 && layer <= 100)))
		throw new TypeError('layer must be an official PCB image/text layer.');
	return layer;
}

function readState(raw: unknown, method: string): unknown {
	const getter = (raw as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB text getter ${method} is unavailable.`);
	return getter.call(raw);
}

function api(runtime: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable. Open a PCB first.`);
	return value;
}

async function pageUuid(runtime: Record<string, unknown>): Promise<string> {
	const documentApi = api(runtime, 'dmt_Pcb', ['getCurrentPcbInfo']);
	const current = await (documentApi.getCurrentPcbInfo as () => Promise<unknown>).call(documentApi);
	if (!isPlainObjectRecord(current))
		throw new TypeError('EDA current PCB is unavailable.');
	return requiredId(current.uuid, 'EDA current PCB UUID');
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await pageUuid(runtime) !== expected)
		throw new Error('The active PCB changed during the text operation.');
}

function readText(raw: unknown, kind: Kind): TextState {
	const x = readState(raw, 'getState_X');
	const y = readState(raw, 'getState_Y');
	const fontFamily = readState(raw, 'getState_FontFamily');
	if (typeof fontFamily !== 'string')
		throw new TypeError('EDA fontFamily is invalid.');
	const common: TextState = {
		primitiveId: requiredId(readState(raw, 'getState_PrimitiveId'), 'EDA primitiveId'),
		layer: imageLayer(readState(raw, 'getState_Layer')),
		x: x === null && kind === 'attribute' ? null : finiteNumber(x, 'EDA x'),
		y: y === null && kind === 'attribute' ? null : finiteNumber(y, 'EDA y'),
		fontFamily,
		fontSize: finiteNumber(readState(raw, 'getState_FontSize'), 'EDA fontSize'),
		lineWidth: finiteNumber(readState(raw, 'getState_LineWidth'), 'EDA lineWidth'),
		alignMode: finiteNumber(readState(raw, 'getState_AlignMode'), 'EDA alignMode'),
		rotation: finiteNumber(readState(raw, 'getState_Rotation'), 'EDA rotation'),
		reverse: readState(raw, 'getState_Reverse') as boolean,
		expansion: finiteNumber(readState(raw, 'getState_Expansion'), 'EDA expansion'),
		mirror: readState(raw, 'getState_Mirror') as boolean,
		primitiveLock: readState(raw, 'getState_PrimitiveLock') as boolean,
	};
	for (const field of ['reverse', 'mirror', 'primitiveLock'] as const) {
		if (typeof common[field] !== 'boolean')
			throw new TypeError(`EDA ${field} is invalid.`);
	}
	if (kind === 'string') {
		common.text = readState(raw, 'getState_Text') as string;
		if (typeof common.text !== 'string')
			throw new TypeError('EDA text is invalid.');
	}
	else {
		common.parentPrimitiveId = requiredId(readState(raw, 'getState_ParentPrimitiveId'), 'EDA parentPrimitiveId');
		common.key = readState(raw, 'getState_Key') as string;
		common.value = readState(raw, 'getState_Value') as string;
		common.keyVisible = readState(raw, 'getState_KeyVisible') as boolean;
		common.valueVisible = readState(raw, 'getState_ValueVisible') as boolean;
		if (typeof common.key !== 'string' || typeof common.value !== 'string'
			|| typeof common.keyVisible !== 'boolean' || typeof common.valueVisible !== 'boolean') {
			throw new TypeError('EDA PCB attribute state is invalid.');
		}
	}
	return common;
}

function primitiveApi(runtime: Record<string, unknown>, kind: Kind, methods: string[]): Record<string, unknown> {
	return api(runtime, kind === 'string' ? 'pcb_PrimitiveString' : 'pcb_PrimitiveAttribute', methods);
}

async function getOne(runtime: Record<string, unknown>, kind: Kind, id: string, page: string): Promise<TextState | undefined> {
	const native = primitiveApi(runtime, kind, ['get']);
	const raw = await (native.get as (id: string) => Promise<unknown>).call(native, id);
	await assertSamePage(runtime, page);
	return raw == null ? undefined : readText(raw, kind);
}

async function getAll(runtime: Record<string, unknown>, kind: Kind, page: string, parentPrimitiveId?: string): Promise<TextState[]> {
	const native = primitiveApi(runtime, kind, ['getAll']);
	const raw = kind === 'attribute' && parentPrimitiveId
		? await (native.getAll as (id: string) => Promise<unknown>).call(native, parentPrimitiveId)
		: await (native.getAll as () => Promise<unknown>).call(native);
	if (!Array.isArray(raw))
		throw new TypeError(`EDA pcb_Primitive${kind === 'string' ? 'String' : 'Attribute'}.getAll did not return an array.`);
	const items = preserveBoundedArray(raw.map(item => readText(item, kind)));
	await assertSamePage(runtime, page);
	return items;
}

async function verifyLayer(runtime: Record<string, unknown>, layer: number): Promise<void> {
	const layerApi = api(runtime, 'pcb_Layer', ['getAllLayers']);
	const layers = await (layerApi.getAllLayers as () => Promise<unknown>).call(layerApi);
	if (!Array.isArray(layers))
		throw new TypeError('EDA pcb_Layer.getAllLayers did not return an array.');
	const selected = layers.find(item => isPlainObjectRecord(item) && item.id === layer);
	if (!isPlainObjectRecord(selected) || selected.layerStatus === 0 || selected.locked === true)
		throw new TypeError(`PCB text layer ${String(layer)} is unavailable, disabled, or locked.`);
}

function requestedProperty(value: unknown, kind: Kind): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	const allowed = kind === 'string' ? STRING_FIELDS : ATTRIBUTE_FIELDS;
	const result: Record<string, unknown> = {};
	for (const [field, item] of Object.entries(value)) {
		if (!allowed.has(field))
			throw new TypeError(`Unsupported PCB ${kind} property: ${field}.`);
		if (field === 'layer') {
			result.layer = imageLayer(item);
		}
		else if (['x', 'y', 'rotation', 'expansion'].includes(field)) {
			result[field] = finiteNumber(item, field);
		}
		else if (['fontSize', 'lineWidth'].includes(field)) {
			const number = finiteNumber(item, field);
			if (number <= 0)
				throw new RangeError(`${field} must be positive.`);
			result[field] = number;
		}
		else if (field === 'alignMode') {
			const alignMode = finiteNumber(item, field);
			if (!Number.isInteger(alignMode) || alignMode < 1 || alignMode > 9)
				throw new TypeError('alignMode must be 1 through 9.');
			result[field] = alignMode;
		}
		else if (['reverse', 'mirror', 'primitiveLock', 'keyVisible', 'valueVisible'].includes(field)) {
			if (typeof item !== 'boolean')
				throw new TypeError(`${field} must be a boolean.`);
			result[field] = item;
		}
		else {
			if (typeof item !== 'string')
				throw new TypeError(`${field} must be a string.`);
			result[field] = item;
		}
	}
	return result;
}

function matchesRequested(actual: TextState, requested: Record<string, unknown>): boolean {
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

export async function handlePcbTextManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_text_manage payload must be an object.');
	const action = payload.action as Action;
	if (!['read', 'create', 'modify', 'delete'].includes(action))
		throw new TypeError('action must be read, create, modify, or delete.');
	const kind = payload.kind as Kind | undefined;
	if (kind !== undefined && kind !== 'string' && kind !== 'attribute')
		throw new TypeError('kind must be string or attribute.');
	if (action !== 'read' && !kind)
		throw new TypeError('kind is required for PCB text writes.');
	if (action === 'create' && kind !== 'string')
		throw new TypeError('Only standalone PCB strings can be created.');
	if (action === 'delete' && kind !== 'string')
		throw new TypeError('Only standalone PCB strings can be deleted.');
	const primitiveId = payload.primitiveId === undefined ? undefined : requiredId(payload.primitiveId, 'primitiveId');
	if ((action === 'modify' || action === 'delete') && !primitiveId)
		throw new TypeError('primitiveId is required.');
	if (primitiveId && !kind)
		throw new TypeError('kind is required when reading by primitiveId.');
	const parentPrimitiveId = payload.parentPrimitiveId === undefined ? undefined : requiredId(payload.parentPrimitiveId, 'parentPrimitiveId');
	if (parentPrimitiveId && kind !== 'attribute')
		throw new TypeError('parentPrimitiveId is only valid for attributes.');
	if (action === 'modify' && kind === 'attribute' && !parentPrimitiveId)
		throw new TypeError('parentPrimitiveId is required when modifying a component attribute.');
	const requested = action === 'modify' ? requestedProperty(payload.property, kind!) : undefined;
	const create = action === 'create'
		? requestedProperty({ ...DEFAULT_STRING_STYLE, ...Object.fromEntries([...STRING_FIELDS].filter(field => payload[field] !== undefined).map(field => [field, payload[field]])) }, 'string')
		: undefined;
	if (create && (create.layer === undefined || create.x === undefined || create.y === undefined || create.text === undefined))
		throw new TypeError('layer, x, y, and text are required for PCB string creation.');
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const page = await pageUuid(runtime);
	if (action === 'read') {
		if (primitiveId) {
			const item = await getOne(runtime, kind!, primitiveId, page);
			return { ok: true, action, scope: SCOPE, pageUuid: page, kind, primitiveId, found: item !== undefined, item: item ?? null };
		}
		const strings = kind === 'attribute' ? undefined : await getAll(runtime, 'string', page);
		const attributes = kind === 'string' ? undefined : await getAll(runtime, 'attribute', page, parentPrimitiveId);
		return { ok: true, action, scope: SCOPE, pageUuid: page, complete: !kind && !parentPrimitiveId, ...(strings ? { stringCount: strings.length, strings } : {}), ...(attributes ? { attributeCount: attributes.length, attributes } : {}) };
	}
	const native = primitiveApi(runtime, kind!, [action, 'get', 'getAll']);
	const context: Record<string, unknown> = { pageUuid: page, kind, ...(primitiveId ? { primitiveId } : {}), ...(parentPrimitiveId ? { parentPrimitiveId } : {}) };
	const before = primitiveId ? await getOne(runtime, kind!, primitiveId, page) : undefined;
	if (primitiveId && !before)
		throw new TypeError(`PCB ${kind} ${primitiveId} does not exist on the current page.`);
	if (parentPrimitiveId) {
		if (before?.parentPrimitiveId !== parentPrimitiveId)
			throw new TypeError('PCB attribute does not belong to the requested component.');
		const componentApi = api(runtime, 'pcb_PrimitiveComponent', ['get']);
		const component = await (componentApi.get as (id: string) => Promise<unknown>).call(componentApi, parentPrimitiveId);
		await assertSamePage(runtime, page);
		if (!component)
			throw new TypeError('Parent PCB component does not exist on the current page.');
	}
	const beforeIds = action === 'create' ? (await getAll(runtime, 'string', page)).map(item => item.primitiveId) : undefined;
	if (beforeIds)
		context.beforePrimitiveIds = beforeIds;
	await verifyLayer(runtime, imageLayer(requested?.layer ?? create?.layer ?? before!.layer));
	await assertSamePage(runtime, page);
	let nativeResult: unknown;
	try {
		if (action === 'create') {
			nativeResult = await (native.create as (...args: unknown[]) => Promise<unknown>).call(native, create!.layer, create!.x, create!.y, create!.text, create!.fontFamily, create!.fontSize, create!.lineWidth, create!.alignMode, create!.rotation, create!.reverse, create!.expansion, create!.mirror, create!.primitiveLock);
		}
		else if (action === 'modify') {
			nativeResult = await (native.modify as (id: string, property: Record<string, unknown>) => Promise<unknown>).call(native, primitiveId!, requested!);
		}
		else {
			nativeResult = await (native.delete as (id: string) => Promise<unknown>).call(native, primitiveId!);
		}
	}
	catch (error: unknown) {
		return unknownWrite(action, error, context, false);
	}
	try {
		await assertSamePage(runtime, page);
		if (action === 'create') {
			const all = await getAll(runtime, 'string', page);
			const added = all.filter(item => !beforeIds!.includes(item.primitiveId));
			const returnedId = nativeResult == null ? undefined : requiredId(readState(nativeResult, 'getState_PrimitiveId'), 'EDA created primitiveId');
			const created = returnedId ? added.find(item => item.primitiveId === returnedId) : added.length === 1 ? added[0] : undefined;
			if (!created || added.length !== 1 || !matchesRequested(created, create!))
				throw new Error('EDA did not read back exactly one matching new PCB string.');
			return { ok: true, action, scope: SCOPE, pageUuid: page, kind, primitiveId: created.primitiveId, item: created, verified: true };
		}
		const observed = await getOne(runtime, kind!, primitiveId!, page);
		if (action === 'modify') {
			if (!observed || !matchesRequested(observed, requested!) || (parentPrimitiveId && observed.parentPrimitiveId !== parentPrimitiveId))
				throw new Error('EDA PCB text readback differs from the requested properties.');
			return { ok: true, action, scope: SCOPE, pageUuid: page, kind, primitiveId, item: observed, verified: true };
		}
		if (nativeResult === false || observed !== undefined)
			throw new Error('EDA PCB string still exists after delete.');
		return { ok: true, action, scope: SCOPE, pageUuid: page, kind, primitiveId, deleted: true, verified: true };
	}
	catch (error: unknown) {
		return unknownWrite(action, error, context, true);
	}
}
