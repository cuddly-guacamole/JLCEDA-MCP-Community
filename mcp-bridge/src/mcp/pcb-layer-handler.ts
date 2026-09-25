import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage, toSerializableAsync } from '../utils.ts';

const SCOPE = 'current_pcb_page';
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;

interface PcbLayerApi {
	getAllLayers?: () => Promise<unknown>;
	getTheNumberOfCopperLayers?: () => Promise<unknown>;
	setTheNumberOfCopperLayers?: (count: number) => Promise<unknown>;
}

function getPcbLayerApi(): PcbLayerApi {
	const eda = getEdaRuntime();
	const api = eda?.pcb_Layer;
	if (!isPlainObjectRecord(api)) {
		throw new TypeError('EDA pcb_Layer API is unavailable. Open a PCB document first.');
	}
	return api as PcbLayerApi;
}

export async function handlePcbLayerQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('pcb_layer_query payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	if (input.kind !== undefined && input.kind !== 'layers')
		throw new TypeError('kind must be layers when provided.');
	const api = getPcbLayerApi();

	if (typeof api.getAllLayers !== 'function')
		throw new TypeError('EDA pcb_Layer.getAllLayers API is unavailable in this client version.');
	const layers = await toSerializableAsync(await api.getAllLayers());
	const copperLayerCount = typeof api.getTheNumberOfCopperLayers === 'function'
		? await toSerializableAsync(await api.getTheNumberOfCopperLayers())
		: undefined;
	return { ok: true, kind: 'layers', layers, ...(copperLayerCount !== undefined ? { copperLayerCount } : {}) };
}

async function currentPcbUuid(): Promise<string> {
	const runtime = getEdaRuntime();
	const pcbApi = runtime?.dmt_Pcb;
	if (!isPlainObjectRecord(pcbApi) || typeof pcbApi.getCurrentPcbInfo !== 'function')
		throw new TypeError('EDA dmt_Pcb.getCurrentPcbInfo API is unavailable. Open a PCB document first.');
	const page = await (pcbApi.getCurrentPcbInfo as () => Promise<unknown>).call(pcbApi);
	if (!isPlainObjectRecord(page) || typeof page.uuid !== 'string' || !page.uuid)
		throw new TypeError('Current PCB UUID is unavailable.');
	return page.uuid;
}

async function readLayerState(api: PcbLayerApi, pageUuid: string): Promise<Record<string, unknown>> {
	if (typeof api.getAllLayers !== 'function' || typeof api.getTheNumberOfCopperLayers !== 'function')
		throw new TypeError('EDA PCB copper-layer readback API is unavailable.');
	const copperLayerCount = await api.getTheNumberOfCopperLayers();
	const rawLayers = await api.getAllLayers();
	if (!Number.isInteger(copperLayerCount) || !Array.isArray(rawLayers)
		|| rawLayers.some(layer => !isPlainObjectRecord(layer) || !Number.isInteger(layer.id) || typeof layer.type !== 'string'
			|| ![0, 1, 2].includes(layer.layerStatus as number))
		|| new Set(rawLayers.map(layer => layer.id)).size !== rawLayers.length) {
		throw new TypeError('EDA PCB copper-layer readback is incomplete.');
	}
	const enabledCopperLayerCount = rawLayers.filter(layer => (layer.type === 'SIGNAL' || layer.type === 'PLANE')
		&& (layer.layerStatus === 1 || layer.layerStatus === 2)).length;
	if (enabledCopperLayerCount !== copperLayerCount)
		throw new Error('EDA copper-layer count disagrees with the enabled SIGNAL/PLANE layer list.');
	const serializedLayers = await toSerializableAsync(preserveBoundedArray(rawLayers));
	if (!Array.isArray(serializedLayers))
		throw new TypeError('EDA PCB layer serialization is incomplete.');
	const layers = preserveBoundedArray(serializedLayers);
	if (await currentPcbUuid() !== pageUuid)
		throw new Error('The active PCB changed during copper-layer readback.');
	return { ok: true, action: 'read', scope: SCOPE, pageUuid, complete: true, copperLayerCount, layerCount: rawLayers.length, layers };
}

function unknownLayerWrite(error: unknown, pageUuid: string, requestedCopperLayerCount: number, beforeCopperLayerCount: unknown, nativeCallSettled: boolean): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!nativeCallSettled && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action: 'set', scope: SCOPE, pageUuid, requestedCopperLayerCount, beforeCopperLayerCount, reason: nativeCallSettled ? 'post_write_readback_failed' : 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled };
}

export async function handlePcbLayerManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_layer_manage payload must be an object.');
	const action = payload.action;
	if (action !== 'read' && action !== 'set')
		throw new TypeError('action must be read or set.');
	const requested = payload.copperLayerCount;
	if (action === 'set' && (!Number.isInteger(requested) || Number(requested) < 2 || Number(requested) > 32 || Number(requested) % 2 !== 0))
		throw new TypeError('copperLayerCount must be an even integer from 2 through 32.');
	const pageUuid = await currentPcbUuid();
	const api = getPcbLayerApi();
	const before = await readLayerState(api, pageUuid);
	if (action === 'read')
		return before;
	if (before.copperLayerCount === requested)
		return { ok: true, action, scope: SCOPE, pageUuid, copperLayerCount: requested, previousCopperLayerCount: before.copperLayerCount, changed: false, verified: true };
	if (typeof api.setTheNumberOfCopperLayers !== 'function')
		throw new TypeError('EDA pcb_Layer.setTheNumberOfCopperLayers API is unavailable in this client version.');
	if (await currentPcbUuid() !== pageUuid)
		throw new Error('The active PCB changed before setting its copper-layer count.');
	let nativeResult: unknown;
	try {
		nativeResult = await api.setTheNumberOfCopperLayers(requested as number);
	}
	catch (error: unknown) {
		return unknownLayerWrite(error, pageUuid, requested as number, before.copperLayerCount, false);
	}
	let after: Record<string, unknown>;
	try {
		after = await readLayerState(api, pageUuid);
	}
	catch (error: unknown) {
		return unknownLayerWrite(error, pageUuid, requested as number, before.copperLayerCount, true);
	}
	if (nativeResult === true && after.copperLayerCount === requested)
		return { ok: true, action, scope: SCOPE, pageUuid, copperLayerCount: after.copperLayerCount, previousCopperLayerCount: before.copperLayerCount, changed: true, verified: true, layerCount: after.layerCount, layers: after.layers };
	if (nativeResult === false && after.copperLayerCount === before.copperLayerCount)
		return { ok: false, action, scope: SCOPE, pageUuid, reason: 'native_rejected', requestedCopperLayerCount: requested, copperLayerCount: after.copperLayerCount, verified: true };
	return unknownLayerWrite(new Error('EDA copper-layer count differs from the requested result.'), pageUuid, requested as number, before.copperLayerCount, true);
}
