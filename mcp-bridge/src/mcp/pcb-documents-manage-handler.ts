import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';

type Operation = 'list' | 'create' | 'copy' | 'rename';

interface PcbDocument {
	uuid: string;
	name: string;
	parentProjectUuid: string;
	parentBoardName: string | null;
	itemType: unknown;
}

const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const INVENTORY_SYNC_DELAY_MS = 1_500;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function api(runtime: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable.`);
	return value;
}

function pcbDocument(value: unknown): PcbDocument {
	if (!isPlainObjectRecord(value))
		throw new TypeError('EDA PCB document info is invalid.');
	const uuid = requiredString(value.uuid, 'EDA PCB uuid');
	const name = requiredString(value.name, 'EDA PCB name');
	const parentProjectUuid = requiredString(value.parentProjectUuid, 'EDA PCB parentProjectUuid');
	if (value.parentBoardName !== undefined && value.parentBoardName !== null && typeof value.parentBoardName !== 'string')
		throw new TypeError('EDA PCB parentBoardName is invalid.');
	return { uuid, name, parentProjectUuid, parentBoardName: value.parentBoardName ?? null, itemType: value.itemType };
}

async function currentProjectUuid(runtime: Record<string, unknown>): Promise<string> {
	const projectApi = api(runtime, 'dmt_Project', ['getCurrentProjectInfo']);
	const project = await (projectApi.getCurrentProjectInfo as () => Promise<unknown>).call(projectApi);
	if (!isPlainObjectRecord(project))
		throw new TypeError('EDA current project is unavailable.');
	return requiredString(project.uuid, 'EDA current project uuid');
}

async function assertProject(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await currentProjectUuid(runtime) !== expected)
		throw new Error('The active EDA project changed during the PCB document operation.');
}

async function getOne(pcbApi: Record<string, unknown>, pcbUuid: string, projectUuid: string): Promise<PcbDocument | undefined> {
	const raw = await (pcbApi.getPcbInfo as (id: string) => Promise<unknown>).call(pcbApi, pcbUuid);
	if (raw === undefined || raw === null)
		return undefined;
	const pcb = pcbDocument(raw);
	if (pcb.uuid !== pcbUuid)
		throw new TypeError(`EDA returned PCB ${pcb.uuid} for requested PCB ${pcbUuid}.`);
	if (pcb.parentProjectUuid !== projectUuid)
		throw new TypeError(`PCB ${pcbUuid} does not belong to project ${projectUuid}.`);
	return pcb;
}

async function getAll(pcbApi: Record<string, unknown>, projectUuid: string): Promise<PcbDocument[]> {
	const raw = await (pcbApi.getAllPcbsInfo as () => Promise<unknown>).call(pcbApi);
	if (!Array.isArray(raw))
		throw new TypeError('EDA dmt_Pcb.getAllPcbsInfo did not return an array.');
	const pcbs = raw.map(pcbDocument).filter(pcb => pcb.parentProjectUuid === projectUuid);
	if (new Set(pcbs.map(pcb => pcb.uuid)).size !== pcbs.length)
		throw new TypeError('EDA PCB inventory contains duplicate UUIDs.');
	return preserveBoundedArray(pcbs);
}

function unknownWrite(operation: Exclude<Operation, 'list'>, error: unknown, nativeCallSettled: boolean, context: Record<string, unknown>): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!nativeCallSettled && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return {
		ok: false,
		operation,
		...context,
		reason: nativeCallSettled ? 'post_write_readback_failed' : 'native_call_result_unknown',
		error: message,
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled,
	};
}

async function waitForInventorySync(): Promise<void> {
	// The official PCB API examples wait for the workspace inventory to refresh.
	await new Promise<void>(resolve => globalThis.setTimeout(resolve, INVENTORY_SYNC_DELAY_MS));
}

export async function handlePcbDocumentsManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_documents_manage payload must be an object.');
	const operation = payload.operation;
	if (operation !== 'list' && operation !== 'create' && operation !== 'copy' && operation !== 'rename')
		throw new TypeError('operation must be list, create, copy, or rename.');
	const projectUuid = requiredString(payload.projectUuid, 'projectUuid');
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const pcbApi = api(runtime, 'dmt_Pcb', ['getAllPcbsInfo', 'getPcbInfo']);
	await assertProject(runtime, projectUuid);
	if (operation === 'list') {
		const pcbs = await getAll(pcbApi, projectUuid);
		await assertProject(runtime, projectUuid);
		return { ok: true, operation, projectUuid, complete: true, pcbCount: pcbs.length, pcbs };
	}
	if (payload.confirm !== true)
		throw new TypeError('confirm must be true before modifying PCB documents.');
	const boardName = payload.boardName === undefined ? undefined : requiredString(payload.boardName, 'boardName');
	const pcbUuid = operation === 'copy' || operation === 'rename' ? requiredString(payload.pcbUuid, 'pcbUuid') : undefined;
	const newName = operation === 'rename' ? requiredString(payload.newName, 'newName') : undefined;
	if (operation === 'rename' && boardName !== undefined)
		throw new TypeError('boardName is not used for rename.');
	const before = operation === 'create' ? undefined : await getOne(pcbApi, pcbUuid as string, projectUuid);
	if (operation !== 'create' && !before)
		throw new TypeError(`PCB ${pcbUuid} does not exist in project ${projectUuid}.`);
	const beforePcbUuids = operation === 'rename' ? undefined : preserveBoundedArray((await getAll(pcbApi, projectUuid)).map(pcb => pcb.uuid));
	if (operation === 'rename') {
		// The native rename API only works when its PCB is already open. Do not
		// switch the user's active document as a side effect of this tool.
		const current = await (api(runtime, 'dmt_Pcb', ['getCurrentPcbInfo']).getCurrentPcbInfo as () => Promise<unknown>).call(pcbApi);
		if (!isPlainObjectRecord(current) || current.uuid !== pcbUuid)
			throw new TypeError('Open the target PCB in EDA before renaming it.');
	}
	await assertProject(runtime, projectUuid);
	const context = { projectUuid, ...(pcbUuid ? { pcbUuid } : {}), ...(before ? { before } : {}), ...(beforePcbUuids ? { beforePcbUuids } : {}) };
	let result: unknown;
	try {
		if (operation === 'create') {
			result = await (api(runtime, 'dmt_Pcb', ['createPcb']).createPcb as (name?: string) => Promise<unknown>).call(pcbApi, boardName);
		}
		else if (operation === 'copy') {
			result = await (api(runtime, 'dmt_Pcb', ['copyPcb']).copyPcb as (id: string, name?: string) => Promise<unknown>).call(pcbApi, pcbUuid as string, boardName);
		}
		else {
			result = await (api(runtime, 'dmt_Pcb', ['modifyPcbName']).modifyPcbName as (id: string, name: string) => Promise<unknown>).call(pcbApi, pcbUuid as string, newName as string);
		}
	}
	catch (error: unknown) {
		return unknownWrite(operation, error, false, context);
	}
	if (operation === 'rename' && result !== true)
		return { ok: false, operation, ...context, reason: 'native_rejected', changed: false };
	if (operation !== 'rename' && (typeof result !== 'string' || !result.trim()))
		return { ok: false, operation, ...context, reason: 'native_rejected', changed: false };
	const resultingPcbUuid = operation === 'rename' ? pcbUuid as string : (result as string).trim();
	try {
		await waitForInventorySync();
		await assertProject(runtime, projectUuid);
		const pcb = await getOne(pcbApi, resultingPcbUuid, projectUuid);
		const pcbs = await getAll(pcbApi, projectUuid);
		if (!pcb || !pcbs.some(item => item.uuid === resultingPcbUuid))
			throw new Error('PCB document is absent from the project inventory after the write.');
		if (beforePcbUuids?.includes(resultingPcbUuid))
			throw new Error('EDA returned an existing PCB UUID instead of a new document.');
		if (operation === 'rename' && pcb.name.toLowerCase() !== (newName as string).toLowerCase())
			throw new Error('PCB name does not match the requested name after the write.');
		if (boardName && pcb.parentBoardName?.toLowerCase() !== boardName.toLowerCase())
			throw new Error('PCB board association does not match the requested board name.');
		await assertProject(runtime, projectUuid);
		return { ok: true, operation, projectUuid, pcbUuid: resultingPcbUuid, pcb, pcbCount: pcbs.length, verified: true };
	}
	catch (error: unknown) {
		return unknownWrite(operation, error, true, { ...context, resultingPcbUuid });
	}
}
