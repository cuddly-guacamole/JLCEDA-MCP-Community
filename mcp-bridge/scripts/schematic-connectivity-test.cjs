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
		getState_X: () => state.x + (state.readbackDeltaX ?? 0),
		getState_Y: () => state.y + (state.readbackDeltaY ?? 0),
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

function attribute(id, parentId, key, value, x, y) {
	return {
		getState_PrimitiveId: () => id,
		getState_ParentPrimitiveId: () => parentId,
		getState_Key: () => key,
		getState_Value: () => value,
		getState_X: () => x,
		getState_Y: () => y,
	};
}

async function main() {
	const wires = [wire('wire-a', 'NET_A', [0, 0, 100, 0])];
	const ports = [{ id: 'port-a', net: 'NET_A', x: 0, y: 0 }];
	let wireReads = 0;
	const attributes = [];
	let wireCreates = 0;
	let portCreates = 0;
	let createdPortReadbackDeltaY = 0;
	globalThis.eda = {
		sch_PrimitiveWire: {
			async getAll() {
				wireReads += 1;
				return wires;
			},
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
				const state = { id: `port-${portCreates}`, net, x, y, readbackDeltaY: createdPortReadbackDeltaY };
				ports.push(state);
				return port(state);
			},
		},
		sch_PrimitiveAttribute: {
			async getAll() { return attributes; },
		},
		sch_Drc: { async check() { return true; } },
	};

	const oversizedLine = Array.from({ length: 257 }, (_, index) => [index, 0]).flat();
	for (const action of ['wire_preview', 'wire_create'])
		await assert.rejects(handleSchematicConnectivityTask({ action, line: oversizedLine }), /at most 512 coordinates/);
	assert.equal(wireReads, 0, 'oversized input must fail before EDA readback');
	assert.equal(wireCreates, 0);

	// The input limit must not reject longer wires already present on the EDA page.
	wires.push(wire('long-existing', '', Array.from({ length: 257 }, (_, index) => [10000 + index, 0]).flat()));
	const previewBesideLongWire = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 100, 10, 100] });
	assert.equal(previewBesideLongWire.canCreate, true);
	wires.pop();

	const preview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [50, -50, 50, 0], net: 'NET_A' });
	assert.equal(preview.canCreate, false);
	assert.deepEqual(preview.unapprovedWireIds, ['wire-a']);
	assert.equal(wireCreates, 0);

	const blocked = await handleSchematicConnectivityTask({ action: 'wire_create', line: [50, -50, 50, 0], net: 'NET_B', allowedWireIds: ['wire-a'] });
	assert.equal(blocked.canCreate, false);
	assert.deepEqual(blocked.conflictingNetWireIds, ['wire-a']);
	assert.equal(wireCreates, 0);

	const created = await handleSchematicConnectivityTask({ action: 'wire_create', line: [50, -50, 50, 0], net: 'NET_A', allowedWireIds: ['wire-a'] });
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
	const nestedConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [350, -20, 350, 0], net: 'NET_D' });
	assert.deepEqual(nestedConflict.conflictingNetWireIds, ['wire-nested']);
	wires.push(wire('wire-multipart', 'NET_E', [[500, 0, 600, 0], [600, 0, 600, 50]]));
	const multipartConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [550, -20, 550, 0], net: 'NET_D' });
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

	// Pro NetLabels are NET attributes of wires; the displayed text may be away
	// from the electrical contact, and the wire's cached net getter may be empty.
	wires.splice(0, wires.length, wire('labeled-wire', '', [0, 0, 100, 0]));
	ports.splice(0, ports.length);
	attributes.splice(0, attributes.length);
	attributes.push(attribute('label-a', 'labeled-wire', 'NET', 'NET_A', 500, 500));
	attributes.push(attribute('component-net', 'component-id', 'NET', 'NET_B', 50, 0));
	attributes.push(attribute('designator', 'labeled-wire', 'Designator', 'NET_B', 50, 0));
	const labeledWireLine = [100, 0, 150, 0];
	const labelConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] });
	assert.equal(labelConflict.canCreate, false);
	assert.deepEqual(labelConflict.conflictingNetWireIds, ['labeled-wire']);
	assert.deepEqual(labelConflict.touches[0].effectiveNets, ['NET_A']);
	const createsBeforeLabelConflict = wireCreates;
	const blockedByLabel = await handleSchematicConnectivityTask({ action: 'wire_create', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] });
	assert.equal(blockedByLabel.canCreate, false);
	assert.equal(wireCreates, createsBeforeLabelConflict);
	const sameLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_A', allowedWireIds: ['labeled-wire'] });
	assert.equal(sameLabelNet.canCreate, true);
	wires[0] = wire('labeled-wire', 'NET_STALE', [0, 0, 100, 0]);
	const refreshedLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_A', allowedWireIds: ['labeled-wire'] });
	assert.equal(refreshedLabelNet.canCreate, true, 'the NET attribute takes precedence over a lagging wire net getter');
	attributes[0] = attribute('label-a', 'labeled-wire', 'NET', '', 500, 500);
	const clearedLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] });
	assert.equal(clearedLabelNet.canCreate, true, 'an empty NET attribute must override a stale wire net getter');
	attributes[0] = attribute('label-a', 'labeled-wire', 'NET', 'NET_A', 500, 500);
	wires.splice(0, wires.length, wire('labeled-wire', '', [0, 0, 50, 0]), wire('cached-wire', 'NET_STALE', [50, 0, 100, 0]));
	const connectedLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_A', allowedWireIds: ['cached-wire'] });
	assert.equal(connectedLabelNet.canCreate, true, 'a NET label overrides stale net getters throughout the connected wire group');
	assert.deepEqual(connectedLabelNet.touches[0].effectiveNets, ['NET_A']);
	const portCreatesBeforeLabelConflict = portCreates;
	const portBlockedByLabel = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 50, y: 0 });
	assert.equal(portBlockedByLabel.reason, 'target_net_conflict');
	assert.deepEqual(portBlockedByLabel.conflictingPrimitiveIds, ['labeled-wire']);
	assert.equal(portCreates, portCreatesBeforeLabelConflict);
	ports.push({ id: 'moving-port', net: 'NET_B', x: 200, y: 0 });
	const moveBlockedByLabel = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-port', x: 50, y: 0 });
	assert.equal(moveBlockedByLabel.reason, 'target_net_conflict');
	assert.deepEqual(moveBlockedByLabel.conflictingPrimitiveIds, ['labeled-wire']);
	assert.equal(ports[0].x, 200);
	wires.splice(0, wires.length);
	attributes.splice(0, attributes.length, attribute('independent-label', '', 'NET', 'NET_A', 25, 0));
	const independentLabelPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 0, 50, 0], net: 'NET_B' });
	assert.equal(independentLabelPreview.canCreate, false);
	assert.deepEqual(independentLabelPreview.conflictingNetLabelIds, ['independent-label']);
	const independentLabelCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 50, 0], net: 'NET_B' });
	assert.equal(independentLabelCreate.canCreate, false);
	assert.equal(wireCreates, createsBeforeLabelConflict);
	const portAtIndependentLabel = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 25, y: 0 });
	assert.deepEqual(portAtIndependentLabel.conflictingPrimitiveIds, ['independent-label']);
	const moveAtIndependentLabel = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-port', x: 25, y: 0 });
	assert.deepEqual(moveAtIndependentLabel.conflictingPrimitiveIds, ['independent-label']);
	assert.equal(ports[0].x, 200);
	attributes.splice(0, attributes.length);

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
	wires.splice(0, wires.length, wire('cross-only', 'NET_A', [0, 0, 100, 0]));
	const crossingLine = [50, -50, 50, 50];
	const crossingPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: crossingLine, net: 'NET_B' });
	assert.equal(crossingPreview.canCreate, true);
	assert.deepEqual(crossingPreview.touches, []);
	const crossingCreatesBefore = wireCreates;
	const crossingCreated = await handleSchematicConnectivityTask({ action: 'wire_create', line: crossingLine, net: 'NET_B' });
	assert.equal(crossingCreated.ok, true);
	assert.equal(wireCreates, crossingCreatesBefore + 1);
	assert.deepEqual(crossingCreated.touches, []);

	// EDA may read a grid coordinate back as 324.99999999999994 instead of 325.
	const nearly325 = 324.99999999999994;
	wires.splice(0, wires.length, wire('float-end-a', 'NET_A', [300, 325, 325, 325]));
	const nearEndpoint = [325, nearly325, 325, 300];
	const endpointPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: nearEndpoint, net: 'NET_B', allowedWireIds: ['float-end-a'] });
	assert.equal(endpointPreview.canCreate, false);
	assert.deepEqual(endpointPreview.conflictingNetWireIds, ['float-end-a']);
	const wireCreatesBeforeFloat = wireCreates;
	const endpointCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: nearEndpoint, net: 'NET_B', allowedWireIds: ['float-end-a'] });
	assert.equal(endpointCreate.canCreate, false);
	assert.equal(wireCreates, wireCreatesBeforeFloat);
	const actualGap = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [325, 324.99, 325, 300], net: 'NET_B' });
	assert.equal(actualGap.canCreate, true, 'a real 0.01-unit gap must not count as a contact');

	wires.splice(0, wires.length);
	ports.splice(0, ports.length, { id: 'float-port-b', net: 'NET_B', x: 325, y: nearly325 });
	const nearPortLine = [300, 325, 350, 325];
	const portPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: nearPortLine, net: 'NET_A' });
	assert.equal(portPreview.canCreate, false);
	assert.deepEqual(portPreview.conflictingNetPortIds, ['float-port-b']);
	const portCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: nearPortLine, net: 'NET_A' });
	assert.equal(portCreate.canCreate, false);
	assert.equal(wireCreates, wireCreatesBeforeFloat);

	wires.splice(0, wires.length, wire('float-unnamed', '', [300, 325, 350, 325]));
	ports.splice(0, ports.length, { id: 'float-port-a', net: 'NET_A', x: 300, y: nearly325 });
	const remotePortPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [350, 325, 375, 325], net: 'NET_B', allowedWireIds: ['float-unnamed'] });
	assert.equal(remotePortPreview.canCreate, false);
	assert.deepEqual(remotePortPreview.conflictingNetWireIds, ['float-unnamed']);

	// The native wire API rejects diagonal segments; preview and create must agree before calling it.
	wires.splice(0, wires.length);
	ports.splice(0, ports.length);
	const diagonalLine = [0, 0, 100, 100];
	const diagonalPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: diagonalLine });
	assert.equal(diagonalPreview.canCreate, false);
	assert.equal(diagonalPreview.reason, 'non_orthogonal_wire');
	assert.equal(diagonalPreview.requiresBend, true);
	assert.equal(diagonalPreview.segmentIndex, 0);
	const wireCreatesBeforeDiagonal = wireCreates;
	const diagonalCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: diagonalLine });
	assert.equal(diagonalCreate.canCreate, false);
	assert.equal(diagonalCreate.reason, 'non_orthogonal_wire');
	assert.equal(wireCreates, wireCreatesBeforeDiagonal);
	const bentPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 0, 100, 0, 100, 100] });
	assert.equal(bentPreview.canCreate, true);
	const nearAxisCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 1e-13], net: 'NET_A' });
	assert.equal(nearAxisCreate.ok, true);
	assert.deepEqual(wires.at(-1).getState_Line(), [0, 0, 100, 0], 'native API receives an exactly orthogonal line');
	const wireCreatesBeforeTiny = wireCreates;
	await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 0, 1e-13, 1e-13] }), /too short/);
	assert.equal(wireCreates, wireCreatesBeforeTiny);

	// Existing and newly read NetPorts use the same tiny coordinate tolerance as wire contacts.
	wires.splice(0, wires.length);
	const portCreatesBeforeFloat = portCreates;
	ports.splice(0, ports.length, { id: 'foreign-near', net: 'NET_B', x: 325, y: nearly325 });
	const foreignNearCreate = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 325, y: 325 });
	assert.equal(foreignNearCreate.reason, 'target_net_conflict');
	assert.deepEqual(foreignNearCreate.conflictingPrimitiveIds, ['foreign-near']);
	ports.splice(0, ports.length, { id: 'existing-near', net: 'NET_A', x: 325, y: nearly325 });
	const existingNearCreate = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 325, y: 325 });
	assert.equal(existingNearCreate.reason, 'existing_port_direction_unverified');
	assert.equal(portCreates, portCreatesBeforeFloat);
	const unchangedState = { id: 'move-near', net: 'NET_A', x: 325, y: nearly325 };
	ports.splice(0, ports.length, unchangedState);
	const unchangedMove = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'move-near', x: 325, y: 325 });
	assert.equal(unchangedMove.unchanged, true);
	assert.equal(unchangedMove.from.y, nearly325);
	assert.equal(unchangedState.y, nearly325);
	ports.splice(0, ports.length, { id: 'moving-port', net: 'NET_A', x: 300, y: 300 }, { id: 'foreign-near', net: 'NET_B', x: 325, y: nearly325 });
	const foreignNearMove = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-port', x: 325, y: 325 });
	assert.equal(foreignNearMove.reason, 'target_net_conflict');
	assert.deepEqual(foreignNearMove.conflictingPrimitiveIds, ['foreign-near']);
	ports.splice(0, ports.length, { id: 'moving-readback', net: 'NET_A', x: 300, y: 300, readbackDeltaY: nearly325 - 325 });
	const movedWithReadbackNoise = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-readback', x: 325, y: 325 });
	assert.equal(movedWithReadbackNoise.ok, true);
	assert.equal(movedWithReadbackNoise.commitUnknown, false);
	assert.equal(movedWithReadbackNoise.observed.y, nearly325);
	ports.splice(0, ports.length);
	createdPortReadbackDeltaY = nearly325 - 325;
	const createdWithReadbackNoise = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 325, y: 325 });
	assert.equal(createdWithReadbackNoise.ok, true);
	assert.equal(createdWithReadbackNoise.primitiveVerified, true);
	assert.equal(createdWithReadbackNoise.commitUnknown, false);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
