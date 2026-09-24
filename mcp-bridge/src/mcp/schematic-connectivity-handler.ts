import { getEdaRuntime, getSyncState, isPlainObjectRecord } from '../utils.ts';
import { handleSchematicReadTask } from './schematic-read-handler.ts';

interface Point { x: number; y: number }
interface Segment { start: Point; end: Point }
type ConnectivityAction = 'wire_preview' | 'wire_create' | 'netport_create' | 'netport_move';

interface WireState {
	id: string;
	net: string;
	line: unknown;
	segments: Segment[];
}

interface ComponentState {
	id: string;
	type: string;
	net: string;
	x: number;
	y: number;
	primitive: Record<string, unknown>;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${name} must be a finite number.`);
	return value;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError(`${name} must be a non-empty string.`);
	return value.trim();
}

function segmentsFromFlatLine(line: unknown): Segment[] {
	if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0 || line.some(value => typeof value !== 'number' || !Number.isFinite(value)))
		return [];
	const segments: Segment[] = [];
	for (let index = 0; index + 3 < line.length; index += 2) {
		const start = { x: line[index] as number, y: line[index + 1] as number };
		const end = { x: line[index + 2] as number, y: line[index + 3] as number };
		if (start.x !== end.x || start.y !== end.y)
			segments.push({ start, end });
	}
	return segments;
}

function segmentsFromWireLine(line: unknown): Segment[] {
	if (!Array.isArray(line))
		return [];
	if (Array.isArray(line[0])) {
		if (line.some(part => !Array.isArray(part) || part.length % 2 !== 0 || part.some(value => typeof value !== 'number' || !Number.isFinite(value))))
			return [];
		if (line.every(part => Array.isArray(part) && part.length === 2))
			return segmentsFromFlatLine(line.flat());
		return line.flatMap(part => segmentsFromFlatLine(part));
	}
	return segmentsFromFlatLine(line);
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Point, segment: Segment): boolean {
	return orientation(segment.start, segment.end, point) === 0
		&& point.x >= Math.min(segment.start.x, segment.end.x)
		&& point.x <= Math.max(segment.start.x, segment.end.x)
		&& point.y >= Math.min(segment.start.y, segment.end.y)
		&& point.y <= Math.max(segment.start.y, segment.end.y);
}

function segmentsTouch(first: Segment, second: Segment): boolean {
	const firstStart = orientation(first.start, first.end, second.start);
	const firstEnd = orientation(first.start, first.end, second.end);
	const secondStart = orientation(second.start, second.end, first.start);
	const secondEnd = orientation(second.start, second.end, first.end);
	return (firstStart === 0 && pointOnSegment(second.start, first))
		|| (firstEnd === 0 && pointOnSegment(second.end, first))
		|| (secondStart === 0 && pointOnSegment(first.start, second))
		|| (secondEnd === 0 && pointOnSegment(first.end, second))
		|| (((firstStart > 0 && firstEnd < 0) || (firstStart < 0 && firstEnd > 0))
			&& ((secondStart > 0 && secondEnd < 0) || (secondStart < 0 && secondEnd > 0)));
}

function wireApi(eda: Record<string, unknown>): Record<string, unknown> {
	const api = eda.sch_PrimitiveWire;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.getAll API is unavailable.');
	return api;
}

async function readWires(api: Record<string, unknown>): Promise<WireState[]> {
	const result = await (api.getAll as () => Promise<unknown>).call(api);
	if (!Array.isArray(result))
		throw new TypeError('EDA sch_PrimitiveWire.getAll did not return an array.');
	return result.map((primitive: unknown) => {
		const line = getSyncState<unknown>(primitive, 'getState_Line', null);
		const id = String(getSyncState(primitive, 'getState_PrimitiveId', ''));
		if (!id)
			throw new TypeError('EDA wire has no primitive ID, so safe intersection checks are unavailable.');
		const segments = segmentsFromWireLine(line);
		if (segments.length === 0)
			throw new TypeError(`EDA wire ${id} has no readable line geometry, so safe intersection checks are unavailable.`);
		return {
			id,
			net: String(getSyncState(primitive, 'getState_Net', '')),
			line,
			segments,
		};
	});
}

function componentApi(eda: Record<string, unknown>): Record<string, unknown> {
	const api = eda.sch_PrimitiveComponent;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.getAll API is unavailable.');
	return api;
}

async function readComponents(api: Record<string, unknown>): Promise<ComponentState[]> {
	const result = await (api.getAll as (type?: unknown, allPages?: boolean) => Promise<unknown>).call(api, undefined, false);
	if (!Array.isArray(result))
		throw new TypeError('EDA sch_PrimitiveComponent.getAll did not return an array.');
	return result.filter(isPlainObjectRecord).map(primitive => ({
		id: String(getSyncState(primitive, 'getState_PrimitiveId', '')),
		type: String(getSyncState(primitive, 'getState_ComponentType', '')),
		net: String(getSyncState(primitive, 'getState_Net', '')),
		x: Number(getSyncState(primitive, 'getState_X', Number.NaN)),
		y: Number(getSyncState(primitive, 'getState_Y', Number.NaN)),
		primitive,
	}));
}

function wireSnapshot(wire: WireState): string {
	return JSON.stringify({ line: wire.line, net: wire.net });
}

function allowedWireIds(value: unknown): Set<string> {
	if (value === undefined)
		return new Set();
	if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id.trim().length === 0))
		throw new TypeError('allowedWireIds must be an array of non-empty primitive IDs.');
	return new Set(value.map(id => (id as string).trim()));
}

async function handleWireAction(action: 'wire_preview' | 'wire_create', payload: Record<string, unknown>, eda: Record<string, unknown>): Promise<unknown> {
	const line = payload.line;
	const segments = segmentsFromFlatLine(line);
	if (segments.length === 0 || !Array.isArray(line) || segments.length !== line.length / 2 - 1)
		throw new TypeError('line must contain at least two distinct [x,y] points as a flat numeric array.');
	const net = payload.net === undefined ? undefined : requiredString(payload.net, 'net');
	const allowed = allowedWireIds(payload.allowedWireIds);
	const api = wireApi(eda);
	const before = await readWires(api);
	const beforeById = new Map(before.map(wire => [wire.id, wireSnapshot(wire)]));
	const touched = before.filter(wire => wire.segments.some(existing => segments.some(proposed => segmentsTouch(existing, proposed))));
	const touchedPorts = (await readComponents(componentApi(eda))).filter(component => (component.type === 'netport' || component.type === 'netflag') && segments.some(segment => pointOnSegment({ x: component.x, y: component.y }, segment)));
	const conflictingNets = touched.filter(wire => net !== undefined && wire.net.length > 0 && wire.net !== net);
	const conflictingPorts = touchedPorts.filter(component => net !== undefined && component.net.length > 0 && component.net !== net);
	const touchedNetNames = new Set([...touched.map(wire => wire.net), ...touchedPorts.map(component => component.net)].filter(name => name.length > 0));
	const unapproved = touched.filter(wire => !allowed.has(wire.id));
	const touches = touched.map(wire => ({ primitiveId: wire.id, net: wire.net, allowed: allowed.has(wire.id) }));
	const portTouches = touchedPorts.map(component => ({ primitiveId: component.id, net: component.net }));
	const canCreate = conflictingNets.length === 0 && conflictingPorts.length === 0 && touchedNetNames.size <= 1 && unapproved.length === 0;
	if (action === 'wire_preview' || !canCreate)
		return { ok: canCreate, action, canCreate, touches, portTouches, conflictingNetWireIds: conflictingNets.map(wire => wire.id), conflictingNetPortIds: conflictingPorts.map(component => component.id), mixedNamedNets: touchedNetNames.size > 1, unapprovedWireIds: unapproved.map(wire => wire.id) };
	if (typeof api.create !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.create API is unavailable.');
	const result = await (api.create as (line: number[], net?: string) => Promise<unknown>).call(api, line as number[], net);
	const after = await readWires(api);
	const afterIds = new Set(after.map(wire => wire.id));
	const changedWireIds = after.filter(wire => beforeById.get(wire.id) !== wireSnapshot(wire)).map(wire => wire.id);
	const removedWireIds = before.filter(wire => !afterIds.has(wire.id)).map(wire => wire.id);
	const unexpectedChangedWireIds = changedWireIds.filter(id => beforeById.has(id) && !allowed.has(id));
	const unexpectedRemovedWireIds = removedWireIds.filter(id => !allowed.has(id));
	const returnedPrimitiveId = String(getSyncState(result, 'getState_PrimitiveId', ''));
	const committed = changedWireIds.length > 0 || removedWireIds.length > 0;
	return {
		ok: committed && unexpectedChangedWireIds.length === 0 && unexpectedRemovedWireIds.length === 0,
		action,
		committed,
		commitUnknown: !committed || unexpectedChangedWireIds.length > 0 || unexpectedRemovedWireIds.length > 0,
		returnedPrimitiveId,
		returnedExistingWire: beforeById.has(returnedPrimitiveId),
		net: net ?? null,
		changedWireIds,
		removedWireIds,
		unexpectedChangedWireIds,
		unexpectedRemovedWireIds,
		touches,
		portTouches,
		readbackRequired: true,
	};
}

async function handleNetPortMove(payload: Record<string, unknown>, eda: Record<string, unknown>): Promise<unknown> {
	const id = requiredString(payload.id, 'id');
	const x = requiredNumber(payload.x, 'x');
	const y = requiredNumber(payload.y, 'y');
	const api = componentApi(eda);
	const components = await readComponents(api);
	const current = components.find(component => component.id === id);
	if (!current)
		throw new Error(`Current schematic page does not contain primitive ${id}.`);
	if (current.type !== 'netport')
		throw new TypeError(`Primitive ${id} is ${current.type || 'unknown'}, not a NetPort.`);
	if (current.x === x && current.y === y)
		return { ok: true, action: 'netport_move', id, net: current.net, from: { x, y }, to: { x, y }, unchanged: true, netlistReadback: await readTargetNetwork(current.net), semanticScope: 'current_schematic_page_hierarchical_port' };
	const otherPort = components.find(component => component.id !== id && component.type === 'netport' && component.x === x && component.y === y && component.net !== current.net);
	const foreignWire = (await readWires(wireApi(eda))).find(wire => wire.net.length > 0 && wire.net !== current.net && wire.segments.some(segment => pointOnSegment({ x, y }, segment)));
	if (otherPort || foreignWire)
		return { ok: false, action: 'netport_move', reason: 'target_net_conflict', id, target: { x, y }, conflictingPrimitiveIds: [otherPort?.id, foreignWire?.id].filter(Boolean) };
	const primitive = typeof current.primitive.toAsync === 'function'
		? (current.primitive.toAsync as () => unknown).call(current.primitive)
		: current.primitive;
	if (!isPlainObjectRecord(primitive) || typeof primitive.setState_X !== 'function' || typeof primitive.setState_Y !== 'function' || typeof primitive.done !== 'function')
		throw new TypeError('EDA NetPort state setters or done API are unavailable.');
	(primitive.setState_X as (value: number) => unknown).call(primitive, x);
	(primitive.setState_Y as (value: number) => unknown).call(primitive, y);
	await Promise.resolve((primitive.done as () => unknown).call(primitive));
	const observed = (await readComponents(api)).find(component => component.id === id);
	const verified = observed?.x === x && observed.y === y && observed.net === current.net && observed.type === 'netport';
	return {
		ok: verified,
		action: 'netport_move',
		id,
		net: current.net,
		from: { x: current.x, y: current.y },
		to: { x, y },
		observed: observed ? { x: observed.x, y: observed.y, net: observed.net } : null,
		netlistReadback: await readTargetNetwork(current.net),
		commitUnknown: !verified,
		readbackRequired: true,
		semanticScope: 'current_schematic_page_hierarchical_port',
	};
}

async function readTargetNetwork(net: string): Promise<unknown> {
	try {
		const response = await handleSchematicReadTask({});
		if (!isPlainObjectRecord(response) || response.ok !== true || typeof response.schematicCircuitSnapshot !== 'string')
			return { available: false, error: isPlainObjectRecord(response) ? String(response.error ?? 'schematic_read failed') : 'schematic_read failed' };
		const snapshot: unknown = JSON.parse(response.schematicCircuitSnapshot);
		if (!isPlainObjectRecord(snapshot) || !Array.isArray(snapshot.networks))
			return { available: false, error: 'schematic_read returned no network list' };
		const network = snapshot.networks.find(item => isPlainObjectRecord(item) && item.networkName === net);
		const connectedPinRefs = isPlainObjectRecord(network) && Array.isArray(network.connectedPinRefs) ? network.connectedPinRefs : [];
		return {
			available: true,
			found: Boolean(network),
			connectedPinRefs,
		};
	}
	catch (error: unknown) {
		return { available: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function handleNetPortCreate(payload: Record<string, unknown>, eda: Record<string, unknown>): Promise<unknown> {
	const net = requiredString(payload.net, 'net');
	const x = requiredNumber(payload.x, 'x');
	const y = requiredNumber(payload.y, 'y');
	const direction = payload.direction === undefined ? 'BI' : requiredString(payload.direction, 'direction');
	if (direction !== 'IN' && direction !== 'OUT' && direction !== 'BI')
		throw new TypeError('direction must be IN, OUT, or BI.');
	const api = componentApi(eda);
	if (typeof api.createNetPort !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.createNetPort API is unavailable.');
	const before = await readComponents(api);
	const otherPort = before.find(component => component.type === 'netport' && component.x === x && component.y === y && component.net !== net);
	const existingPort = before.find(component => component.type === 'netport' && component.x === x && component.y === y && component.net === net);
	const foreignWire = (await readWires(wireApi(eda))).find(wire => wire.net.length > 0 && wire.net !== net && wire.segments.some(segment => pointOnSegment({ x, y }, segment)));
	if (otherPort || foreignWire)
		return { ok: false, action: 'netport_create', reason: 'target_net_conflict', target: { x, y }, conflictingPrimitiveIds: [otherPort?.id, foreignWire?.id].filter(Boolean) };
	if (existingPort)
		return { ok: true, action: 'netport_create', primitiveId: existingPort.id, net, position: { x, y }, unchanged: true, netlistReadback: await readTargetNetwork(net), semanticScope: 'current_schematic_page_hierarchical_port' };
	const created = await (api.createNetPort as (direction: 'IN' | 'OUT' | 'BI', net: string, x: number, y: number) => Promise<unknown>).call(api, direction, net, x, y);
	const returnedId = String(getSyncState(created, 'getState_PrimitiveId', ''));
	const beforeIds = new Set(before.map(component => component.id));
	const observed = (await readComponents(api)).find(component => !beforeIds.has(component.id) && component.type === 'netport' && component.net === net && component.x === x && component.y === y && (!returnedId || component.id === returnedId));
	const verified = Boolean(observed && observed.type === 'netport' && observed.net === net && observed.x === x && observed.y === y);
	const netlistReadback = await readTargetNetwork(net);
	return {
		ok: verified,
		action: 'netport_create',
		primitiveId: observed?.id || returnedId,
		direction,
		net,
		position: { x, y },
		primitiveVerified: verified,
		netlistReadback,
		commitUnknown: !verified,
		semanticScope: 'current_schematic_page_hierarchical_port',
	};
}

export async function handleSchematicConnectivityTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_connectivity_action payload must be an object.');
	const action = payload.action as ConnectivityAction;
	if (action !== 'wire_preview' && action !== 'wire_create' && action !== 'netport_create' && action !== 'netport_move')
		throw new TypeError('action must be wire_preview, wire_create, netport_create, or netport_move.');
	const eda = getEdaRuntime();
	if (!eda)
		throw new TypeError('EDA runtime is unavailable.');
	if (action === 'netport_move')
		return handleNetPortMove(payload, eda);
	if (action === 'netport_create')
		return handleNetPortCreate(payload, eda);
	return handleWireAction(action, payload, eda);
}
