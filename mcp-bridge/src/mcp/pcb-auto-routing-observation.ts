import { getEdaRuntime, getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils.ts';

interface NetSnapshot {
	net: string;
	length: number;
	routingPrimitiveIds: string[];
}

export interface AutoRoutingSnapshot {
	pageUuid: string;
	nets: NetSnapshot[];
}

const ROUTING_TYPES = new Set(['Track', 'Line', 'Arc', 'Polyline', 'Via']);
const REPORTED_ID_LIMIT = 20;

function api(runtime: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable.`);
	return value;
}

async function currentPageUuid(runtime: Record<string, unknown>): Promise<string> {
	const pcbApi = api(runtime, 'dmt_Pcb', ['getCurrentPcbInfo']);
	const page = await (pcbApi.getCurrentPcbInfo as () => Promise<unknown>).call(pcbApi);
	if (!isPlainObjectRecord(page) || typeof page.uuid !== 'string' || !page.uuid)
		throw new TypeError('Current PCB UUID is unavailable.');
	return page.uuid;
}

function routingPrimitiveId(value: unknown): string | undefined {
	if (!isPlainObjectRecord(value))
		return undefined;
	const type = value.pcbItemPrimitiveType ?? getSyncState(value, 'getState_PrimitiveType', value.primitiveType);
	if (!ROUTING_TYPES.has(String(type)))
		return undefined;
	const id = value.globalIndex ?? getSyncState(value, 'getState_PrimitiveId', value.primitiveId);
	if (typeof id !== 'string' || !id)
		throw new TypeError('PCB routing primitive has no stable ID.');
	return id;
}

export async function readAutoRoutingSnapshot(nets: string[], expectedPageUuid?: string): Promise<AutoRoutingSnapshot> {
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const pageUuid = await currentPageUuid(runtime);
	if (expectedPageUuid && expectedPageUuid !== pageUuid)
		throw new Error('The active PCB changed before autoRouting readback.');
	const netApi = api(runtime, 'pcb_Net', ['getAllPrimitivesByNet', 'getNetLength']);
	const snapshots: NetSnapshot[] = [];
	for (const net of nets) {
		// Passing native primitiveTypes gives an empty list in EDA 3.2.181.
		const raw = await (netApi.getAllPrimitivesByNet as (name: string) => Promise<unknown>).call(netApi, net);
		const length = await (netApi.getNetLength as (name: string) => Promise<unknown>).call(netApi, net);
		if (!Array.isArray(raw) || typeof length !== 'number' || !Number.isFinite(length))
			throw new TypeError(`PCB network ${net} routing readback is incomplete.`);
		const ids = raw.map(routingPrimitiveId).filter((id): id is string => id !== undefined).sort();
		if (new Set(ids).size !== ids.length)
			throw new TypeError(`PCB network ${net} routing readback has duplicate IDs.`);
		snapshots.push({ net, length, routingPrimitiveIds: ids });
	}
	if (await currentPageUuid(runtime) !== pageUuid)
		throw new Error('The active PCB changed during autoRouting readback.');
	return { pageUuid, nets: snapshots };
}

export function compareAutoRoutingSnapshots(before: AutoRoutingSnapshot, after: AutoRoutingSnapshot): Record<string, unknown> {
	if (before.pageUuid !== after.pageUuid || before.nets.length !== after.nets.length
		|| before.nets.some((net, index) => net.net !== after.nets[index].net)) {
		return { status: 'unavailable', scope: 'requested_nets_only', reason: 'PCB page or requested networks changed during readback.' };
	}
	const addedRoutingPrimitiveIds: Record<string, string[]> = Object.create(null);
	const removedRoutingPrimitiveIds: Record<string, string[]> = Object.create(null);
	const nets = before.nets.map((previous, index) => {
		const current = after.nets[index];
		const previousIds = new Set(previous.routingPrimitiveIds);
		const currentIds = new Set(current.routingPrimitiveIds);
		const added = current.routingPrimitiveIds.filter(id => !previousIds.has(id));
		const removed = previous.routingPrimitiveIds.filter(id => !currentIds.has(id));
		addedRoutingPrimitiveIds[previous.net] = added.slice(0, REPORTED_ID_LIMIT);
		removedRoutingPrimitiveIds[previous.net] = removed.slice(0, REPORTED_ID_LIMIT);
		return {
			net: previous.net,
			beforeLength: previous.length,
			beforeRoutingPrimitiveCount: previous.routingPrimitiveIds.length,
			afterLength: current.length,
			afterRoutingPrimitiveCount: current.routingPrimitiveIds.length,
			addedRoutingPrimitiveCount: added.length,
			removedRoutingPrimitiveCount: removed.length,
			idsTruncated: added.length > REPORTED_ID_LIMIT || removed.length > REPORTED_ID_LIMIT,
			observedChange: added.length > 0 || removed.length > 0 || previous.length !== current.length,
		};
	});
	return {
		status: nets.some(net => net.observedChange) ? 'changed' : 'unchanged',
		scope: 'requested_nets_only',
		pageUuid: before.pageUuid,
		provisional: true,
		nets,
		addedRoutingPrimitiveIds,
		removedRoutingPrimitiveIds,
	};
}

export function unavailableAutoRoutingObservation(error: unknown): Record<string, unknown> {
	return { status: 'unavailable', scope: 'requested_nets_only', reason: toSafeErrorMessage(error) };
}
