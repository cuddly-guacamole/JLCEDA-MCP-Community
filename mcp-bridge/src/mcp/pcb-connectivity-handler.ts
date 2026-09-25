import { getEdaRuntime, getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils.ts';

type PcbConnectivityAction = 'line_create' | 'via_create';
const COORDINATE_EPSILON = 1e-6;

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError(`${name} must be a non-empty string.`);
	return value.trim();
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${name} must be a finite number.`);
	return value;
}

function positiveNumber(value: unknown, name: string): number {
	const number = requiredNumber(value, name);
	if (number <= 0)
		throw new RangeError(`${name} must be positive.`);
	return number;
}

function pcbApi(eda: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const api = eda[name];
	if (!isPlainObjectRecord(api) || methods.some(method => typeof api[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable. Open a PCB document first.`);
	return api;
}

function sameNumber(actual: unknown, expected: number): boolean {
	return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= COORDINATE_EPSILON;
}

async function verifyNet(api: Record<string, unknown>, net: string): Promise<void> {
	const nets = await (api.getAllNets as () => Promise<unknown>).call(api);
	if (!Array.isArray(nets))
		throw new TypeError('EDA pcb_Net.getAllNets did not return an array.');
	if (!nets.some(item => isPlainObjectRecord(item) && item.net === net))
		throw new TypeError(`PCB network ${net} does not exist on the current page.`);
}

function nativeCreateFailure(action: PcbConnectivityAction, error: unknown): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	// A timed-out or disconnected RPC can finish inside EDA after it rejects here.
	const commitUnknown = /timed?\s*out|disconnect|connection\s+(?:closed|lost|reset)|socket\s+(?:closed|hang up)|ECONNRESET|EPIPE/i.test(message);
	return {
		ok: false,
		action,
		reason: commitUnknown ? 'native_create_result_unknown' : 'native_create_rejected',
		error: message,
		...(commitUnknown ? { commitUnknown: true, readbackRequired: true, nativeCallSettled: false } : {}),
	};
}

async function verifyCopperLayer(api: Record<string, unknown>, layer: number): Promise<void> {
	const layers = await (api.getAllLayers as () => Promise<unknown>).call(api);
	if (!Array.isArray(layers))
		throw new TypeError('EDA pcb_Layer.getAllLayers did not return an array.');
	const selected = layers.find(item => isPlainObjectRecord(item) && item.id === layer);
	if (!isPlainObjectRecord(selected) || (selected.type !== 'SIGNAL' && selected.type !== 'PLANE') || selected.layerStatus === 0 || selected.locked === true)
		throw new TypeError(`PCB layer ${String(layer)} is not an enabled, unlocked copper layer.`);
}

function unknownAfterWrite(
	action: PcbConnectivityAction,
	returnedPrimitiveId: string,
	error: unknown,
): Record<string, unknown> {
	return {
		ok: false,
		action,
		reason: 'post_write_readback_failed',
		error: toSafeErrorMessage(error),
		returnedPrimitiveId,
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled: true,
	};
}

async function handleLineCreate(payload: Record<string, unknown>, eda: Record<string, unknown>, net: string, allowNewNet: boolean): Promise<unknown> {
	const layer = requiredNumber(payload.layer, 'layer');
	if (!Number.isInteger(layer) || layer <= 0)
		throw new TypeError('layer must be a positive integer PCB layer ID.');
	const startX = requiredNumber(payload.startX, 'startX');
	const startY = requiredNumber(payload.startY, 'startY');
	const endX = requiredNumber(payload.endX, 'endX');
	const endY = requiredNumber(payload.endY, 'endY');
	if (sameNumber(startX, endX) && sameNumber(startY, endY))
		throw new TypeError('A PCB line must have different start and end points.');
	const lineWidth = positiveNumber(payload.lineWidth, 'lineWidth');
	const lineApi = pcbApi(eda, 'pcb_PrimitiveLine', ['create', 'get']);
	const layerApi = pcbApi(eda, 'pcb_Layer', ['getAllLayers']);
	const netApi = allowNewNet ? undefined : pcbApi(eda, 'pcb_Net', ['getAllNets']);
	const preflight = [verifyCopperLayer(layerApi, layer)];
	if (netApi)
		preflight.push(verifyNet(netApi, net));
	await Promise.all(preflight);
	let created: unknown;
	try {
		created = await (lineApi.create as (...args: unknown[]) => Promise<unknown>).call(lineApi, net, layer, startX, startY, endX, endY, lineWidth);
	}
	catch (error: unknown) {
		return nativeCreateFailure('line_create', error);
	}
	const primitiveId = getSyncState(created, 'getState_PrimitiveId', '');
	if (typeof primitiveId !== 'string' || primitiveId.length === 0)
		return unknownAfterWrite('line_create', '', 'EDA create returned no primitive ID.');
	try {
		const observed = await (lineApi.get as (id: string) => Promise<unknown>).call(lineApi, primitiveId);
		const verified = getSyncState(observed, 'getState_PrimitiveId', '') === primitiveId
			&& getSyncState(observed, 'getState_Net', '') === net
			&& getSyncState(observed, 'getState_Layer', -1) === layer
			&& sameNumber(getSyncState(observed, 'getState_StartX', Number.NaN), startX)
			&& sameNumber(getSyncState(observed, 'getState_StartY', Number.NaN), startY)
			&& sameNumber(getSyncState(observed, 'getState_EndX', Number.NaN), endX)
			&& sameNumber(getSyncState(observed, 'getState_EndY', Number.NaN), endY)
			&& sameNumber(getSyncState(observed, 'getState_LineWidth', Number.NaN), lineWidth);
		if (!verified)
			return unknownAfterWrite('line_create', primitiveId, 'EDA line readback differs from the requested net, layer, or geometry.');
		return { ok: true, action: 'line_create', primitiveId, net, layer, startX, startY, endX, endY, lineWidth, verified: true };
	}
	catch (error: unknown) {
		return unknownAfterWrite('line_create', primitiveId, error);
	}
}

async function handleViaCreate(payload: Record<string, unknown>, eda: Record<string, unknown>, net: string, allowNewNet: boolean): Promise<unknown> {
	const x = requiredNumber(payload.x, 'x');
	const y = requiredNumber(payload.y, 'y');
	const holeDiameter = positiveNumber(payload.holeDiameter, 'holeDiameter');
	const diameter = positiveNumber(payload.diameter, 'diameter');
	if (diameter <= holeDiameter)
		throw new RangeError('diameter must be larger than holeDiameter.');
	const viaApi = pcbApi(eda, 'pcb_PrimitiveVia', ['create', 'get']);
	if (!allowNewNet)
		await verifyNet(pcbApi(eda, 'pcb_Net', ['getAllNets']), net);
	let created: unknown;
	try {
		created = await (viaApi.create as (...args: unknown[]) => Promise<unknown>).call(viaApi, net, x, y, holeDiameter, diameter);
	}
	catch (error: unknown) {
		return nativeCreateFailure('via_create', error);
	}
	const primitiveId = getSyncState(created, 'getState_PrimitiveId', '');
	if (typeof primitiveId !== 'string' || primitiveId.length === 0)
		return unknownAfterWrite('via_create', '', 'EDA create returned no primitive ID.');
	try {
		const observed = await (viaApi.get as (id: string) => Promise<unknown>).call(viaApi, primitiveId);
		const verified = getSyncState(observed, 'getState_PrimitiveId', '') === primitiveId
			&& getSyncState(observed, 'getState_Net', '') === net
			&& sameNumber(getSyncState(observed, 'getState_X', Number.NaN), x)
			&& sameNumber(getSyncState(observed, 'getState_Y', Number.NaN), y)
			&& sameNumber(getSyncState(observed, 'getState_HoleDiameter', Number.NaN), holeDiameter)
			&& sameNumber(getSyncState(observed, 'getState_Diameter', Number.NaN), diameter);
		if (!verified)
			return unknownAfterWrite('via_create', primitiveId, 'EDA via readback differs from the requested net or geometry.');
		return { ok: true, action: 'via_create', primitiveId, net, x, y, holeDiameter, diameter, verified: true };
	}
	catch (error: unknown) {
		return unknownAfterWrite('via_create', primitiveId, error);
	}
}

export async function handlePcbConnectivityTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_connectivity_action payload must be an object.');
	const action = payload.action;
	if (action !== 'line_create' && action !== 'via_create')
		throw new TypeError('action must be line_create or via_create.');
	const net = requiredString(payload.net, 'net');
	if (payload.allowNewNet !== undefined && typeof payload.allowNewNet !== 'boolean')
		throw new TypeError('allowNewNet must be a boolean.');
	const allowNewNet = payload.allowNewNet === true;
	const eda = getEdaRuntime();
	if (!eda)
		throw new TypeError('EDA runtime is unavailable.');
	return action === 'line_create'
		? handleLineCreate(payload, eda, net, allowNewNet)
		: handleViaCreate(payload, eda, net, allowNewNet);
}
