const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicConnectivityTask } = require('../src/mcp/schematic-connectivity-handler.ts');

function wire(id, net, line) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_Line: () => line,
	};
}

function port(state) {
	return {
		getState_PrimitiveId: () => state.id,
		getState_ComponentType: () => state.type ?? 'netport',
		getState_Net: () => state.net,
		getState_X: () => state.x,
		getState_Y: () => state.y,
		getState_Designator: () => '',
		toAsync() { return this; },
		setState_X(x) {
			state.pendingX = x;
			return this;
		},
		setState_Y(y) {
			state.pendingY = y;
			return this;
		},
		async done() {
			state.x = state.pendingX;
			state.y = state.pendingY;
			return this;
		},
	};
}

async function main() {
	const wires = [wire('wire-a', 'NET_A', [0, 0, 100, 0])];
	const ports = [{ id: 'port-a', net: 'NET_A', x: 0, y: 0 }];
	let wireCreates = 0;
	let portCreates = 0;
	globalThis.eda = {
		sch_PrimitiveWire: {
			async getAll() { return wires; },
			async create(line, net) {
				wireCreates += 1;
				const created = wire(`wire-${wireCreates}`, net ?? '', line);
				wires.push(created);
				return created;
			},
		},
		sch_PrimitiveComponent: {
			async getAll(_type, allPages) {
				assert.equal(typeof allPages, 'boolean');
				return ports.map(port);
			},
			async getAllPinsByPrimitiveId() { return []; },
			async createNetPort(_direction, net, x, y) {
				portCreates += 1;
				const state = { id: `port-${portCreates}`, net, x, y };
				ports.push(state);
				return port(state);
			},
		},
		sch_Drc: { async check() { return true; } },
	};

	const preview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [50, -50, 50, 50], net: 'NET_A' });
	assert.equal(preview.canCreate, false);
	assert.deepEqual(preview.unapprovedWireIds, ['wire-a']);
	assert.equal(wireCreates, 0);

	const blocked = await handleSchematicConnectivityTask({ action: 'wire_create', line: [50, -50, 50, 50], net: 'NET_B', allowedWireIds: ['wire-a'] });
	assert.equal(blocked.canCreate, false);
	assert.deepEqual(blocked.conflictingNetWireIds, ['wire-a']);
	assert.equal(wireCreates, 0);

	const created = await handleSchematicConnectivityTask({ action: 'wire_create', line: [50, -50, 50, 50], net: 'NET_A', allowedWireIds: ['wire-a'] });
	assert.equal(created.ok, true);
	assert.equal(created.returnedPrimitiveId, 'wire-1');
	assert.deepEqual(created.changedWireIds, ['wire-1']);
	assert.equal(created.readbackRequired, true);
	const originalCreate = globalThis.eda.sch_PrimitiveWire.create;
	globalThis.eda.sch_PrimitiveWire.create = async () => {
		wires[0] = wire('wire-a', 'NET_A', [0, 0, 150, 0]);
		return wires[0];
	};
	const merged = await handleSchematicConnectivityTask({ action: 'wire_create', line: [100, 0, 150, 0], net: 'NET_A', allowedWireIds: ['wire-a'] });
	assert.equal(merged.ok, true);
	assert.equal(merged.returnedExistingWire, true);
	assert.deepEqual(merged.changedWireIds, ['wire-a']);
	globalThis.eda.sch_PrimitiveWire.create = originalCreate;

	const moved = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-a', x: 25, y: 0 });
	assert.equal(moved.ok, true);
	assert.deepEqual(moved.observed, { x: 25, y: 0, net: 'NET_A' });
	assert.equal(moved.netlistReadback.available, true);
	assert.equal(ports[0].id, 'port-a');

	const conflict = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 50, y: 0 });
	assert.equal(conflict.ok, false);
	assert.equal(conflict.reason, 'target_net_conflict');
	assert.equal(portCreates, 0);

	const newPort = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 75, y: 0 });
	assert.equal(newPort.ok, true);
	assert.equal(newPort.primitiveVerified, true);
	assert.equal(newPort.netlistReadback.available, true);
	assert.equal(newPort.netlistReadback.found, true);
	assert.ok(newPort.netlistReadback.connectedPinRefs.includes('NET_A.1'));
	assert.equal(newPort.semanticScope, 'current_schematic_page_hierarchical_port');
	const mismatchedDirection = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', direction: 'OUT', x: 75, y: 0 });
	assert.equal(mismatchedDirection.ok, false);
	assert.equal(mismatchedDirection.reason, 'existing_port_direction_unverified');
	assert.equal(mismatchedDirection.requestedDirection, 'OUT');
	assert.deepEqual(mismatchedDirection.conflictingPrimitiveIds, ['port-1']);
	assert.equal(mismatchedDirection.unchanged, undefined);
	const repeated = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 75, y: 0 });
	assert.equal(repeated.ok, false, 'the documented EDA getters cannot prove the existing port direction even for a repeated request');
	assert.equal(repeated.reason, 'existing_port_direction_unverified');
	assert.equal(portCreates, 1);

	ports.push({ id: 'isolated-b', net: 'NET_B', x: 200, y: 0 });
	const portConflict = await handleSchematicConnectivityTask({ action: 'wire_create', line: [200, -20, 200, 20], net: 'NET_A' });
	assert.equal(portConflict.canCreate, false);
	assert.deepEqual(portConflict.conflictingNetPortIds, ['isolated-b']);
	assert.equal(wireCreates, 1);

	wires.push(wire('wire-nested', 'NET_C', [[300, 0], [400, 0]]));
	const nestedConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [350, -20, 350, 20], net: 'NET_D' });
	assert.deepEqual(nestedConflict.conflictingNetWireIds, ['wire-nested']);
	wires.push(wire('wire-multipart', 'NET_E', [[500, 0, 600, 0], [600, 0, 600, 50]]));
	const multipartConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [550, -20, 550, 20], net: 'NET_D' });
	assert.deepEqual(multipartConflict.conflictingNetWireIds, ['wire-multipart']);
	const inPlaceLine = [700, 0, 800, 0];
	const inPlaceWire = wire('wire-in-place', 'NET_Z', inPlaceLine);
	wires.push(inPlaceWire);
	globalThis.eda.sch_PrimitiveWire.create = async () => {
		inPlaceLine[2] = 850;
		return inPlaceWire;
	};
	const inPlaceChange = await handleSchematicConnectivityTask({ action: 'wire_create', line: [800, 0, 850, 0], net: 'NET_Z', allowedWireIds: ['wire-in-place'] });
	assert.equal(inPlaceChange.ok, true);
	assert.deepEqual(inPlaceChange.changedWireIds, ['wire-in-place']);
	globalThis.eda.sch_PrimitiveWire.create = originalCreate;

	// A distant NetFlag names an otherwise unnamed connected wire component.
	wires.splice(0, wires.length, wire('unnamed-a1', '', [0, 0, 50, 0]), wire('unnamed-a2', '', [50, 0, 100, 0]));
	ports.splice(0, ports.length, { id: 'flag-a', type: 'netflag', net: 'NET_A', x: 0, y: 0 });
	const portCreatesBeforeConflict = portCreates;
	const remotePortConflict = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 100, y: 0 });
	assert.equal(remotePortConflict.ok, false);
	assert.deepEqual(remotePortConflict.conflictingPrimitiveIds, ['unnamed-a2']);
	assert.equal(portCreates, portCreatesBeforeConflict);
	const remoteWireConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [100, 0, 150, 0], net: 'NET_B', allowedWireIds: ['unnamed-a2'] });
	assert.deepEqual(remoteWireConflict.conflictingNetWireIds, ['unnamed-a2']);
	const sameNetWire = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [100, 0, 150, 0], net: 'NET_A', allowedWireIds: ['unnamed-a2'] });
	assert.equal(sameNetWire.canCreate, true);
	ports.push({ id: 'port-b', net: 'NET_B', x: 300, y: 0 });
	const remoteMoveConflict = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-b', x: 100, y: 0 });
	assert.equal(remoteMoveConflict.ok, false);
	assert.deepEqual(remoteMoveConflict.conflictingPrimitiveIds, ['unnamed-a2']);
	assert.equal(ports.find(item => item.id === 'port-b').x, 300);
	wires.splice(0, wires.length);
	ports.splice(0, ports.length, { id: 'flag-b', type: 'netflag', net: 'NET_B', x: 100, y: 0 }, { id: 'port-a', net: 'NET_A', x: 300, y: 0 });
	const directFlagConflict = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 100, y: 0 });
	assert.deepEqual(directFlagConflict.conflictingPrimitiveIds, ['flag-b']);
	const moveOntoFlag = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-a', x: 100, y: 0 });
	assert.deepEqual(moveOntoFlag.conflictingPrimitiveIds, ['flag-b']);

	// Joining two unnamed wires must see their distant, different NetPorts.
	wires.splice(0, wires.length, wire('unnamed-a', '', [0, 0, 100, 0]), wire('unnamed-b', '', [200, 0, 300, 0]));
	ports.splice(0, ports.length, { id: 'port-a', net: 'NET_A', x: 0, y: 0 }, { id: 'port-b', net: 'NET_B', x: 300, y: 0 });
	const joinLine = [100, 0, 200, 0];
	const previewConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: joinLine, allowedWireIds: ['unnamed-a', 'unnamed-b'] });
	assert.equal(previewConflict.canCreate, false);
	assert.equal(previewConflict.mixedNamedNets, true);
	assert.deepEqual(previewConflict.touches.map(item => item.effectiveNets), [['NET_A'], ['NET_B']]);
	const wireCreatesBeforeConflict = wireCreates;
	const createConflict = await handleSchematicConnectivityTask({ action: 'wire_create', line: joinLine, allowedWireIds: ['unnamed-a', 'unnamed-b'] });
	assert.equal(createConflict.canCreate, false);
	assert.equal(wireCreates, wireCreatesBeforeConflict);

	// A crossing without a shared endpoint does not merge two existing nets.
	wires.splice(0, wires.length, wire('cross-a', 'NET_A', [0, 0, 100, 0]), wire('cross-b', 'NET_B', [50, -50, 50, 50]));
	ports.splice(0, ports.length);
	const independentCrossing = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [-50, 0, 0, 0], net: 'NET_A', allowedWireIds: ['cross-a'] });
	assert.equal(independentCrossing.canCreate, true);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
