const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicComponentEditTask } = require('../src/mcp/schematic-component-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/schematic/component-edit';

function primitive(state) {
	const getters = {
		PrimitiveId: 'primitiveId',
		ComponentType: 'type',
		X: 'x',
		Y: 'y',
		Rotation: 'rotation',
		Mirror: 'mirror',
		Designator: 'designator',
		Name: 'name',
		UniqueId: 'uniqueId',
		AddIntoBom: 'addIntoBom',
		AddIntoPcb: 'addIntoPcb',
		Manufacturer: 'manufacturer',
		ManufacturerId: 'manufacturerId',
		Supplier: 'supplier',
		SupplierId: 'supplierId',
		OtherProperty: 'otherProperty',
	};
	return Object.fromEntries(Object.entries(getters).map(([suffix, key]) => [`getState_${suffix}`, () => state[key]]));
}

async function main() {
	let pageUuid = 'page-1';
	const wires = [{ getState_Line: () => [400, 500, 410, 500], getState_Net: () => 'FOREIGN' }];
	const parts = new Map([
		['r1', {
			primitiveId: 'r1',
			type: 'part',
			x: 100,
			y: 200,
			rotation: 0,
			mirror: false,
			designator: 'R1',
			name: 'Resistor',
			uniqueId: 'uid-r1',
			addIntoBom: true,
			addIntoPcb: true,
			manufacturer: 'Maker',
			manufacturerId: 'M-1',
			supplier: 'Supplier',
			supplierId: 'S-1',
			otherProperty: { Value: '10k', Datasheet: 'https://example.test/r' },
		}],
		['c1', {
			primitiveId: 'c1',
			type: 'part',
			x: 300,
			y: 400,
			rotation: 90,
			mirror: true,
			designator: undefined,
			name: undefined,
			uniqueId: undefined,
			addIntoBom: undefined,
			addIntoPcb: undefined,
			manufacturer: undefined,
			manufacturerId: undefined,
			supplier: undefined,
			supplierId: undefined,
			otherProperty: undefined,
		}],
	]);
	let callCount = 0;
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: pageUuid }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: pageUuid }; } },
		sch_PrimitiveComponent: {
			async getAll(type, allPages) {
				assert.ok(type === 'part' || type === undefined);
				assert.equal(allPages, false);
				return [...parts.values()].map(primitive);
			},
			async getAllPrimitiveId(type, allPages) {
				assert.ok(type === 'part' || type === undefined);
				assert.equal(allPages, false);
				return [...parts.keys()];
			},
			async get(id) {
				const state = parts.get(id);
				return state ? primitive(state) : undefined;
			},
			async getAllPinsByPrimitiveId(id) {
				const state = parts.get(id);
				if (!state)
					return [];
				return [{
					getState_PinNumber: () => '1',
					getState_PinName: () => 'P',
					getState_PinType: () => 'passive',
					getState_X: () => state.x,
					getState_Y: () => state.y,
					getState_NoConnected: () => false,
				}];
			},
			async modify(id, property) {
				callCount += 1;
				assert.equal(id, 'r1');
				const current = parts.get(id);
				Object.assign(current, property);
				return primitive(current);
			},
			async delete(target) {
				callCount += 1;
				assert.equal(typeof target.getState_PrimitiveId, 'function', 'delete uses the current-page primitive object');
				parts.delete(target.getState_PrimitiveId());
				return true;
			},
		},
		sch_PrimitiveWire: { async getAll() { return wires; } },
		sch_Drc: { async check() { return true; } },
	};
	const full = await handleSchematicComponentEditTask({ action: 'read' });
	assert.deepEqual([full.ok, full.action, full.scope, full.complete, full.pageUuid, full.componentCount], [true, 'read', 'current_schematic_page', true, 'page-1', 2]);
	assert.deepEqual(full.components[0].otherProperty, { Value: '10k', Datasheet: 'https://example.test/r' });
	assert.deepEqual(full.components[1].otherProperty, {});
	assert.equal(full.components[1].designator, null);
	assert.equal(full.components[1].addIntoBom, null);
	assert.equal(full.components[1].supplierId, null);
	for (let index = 0; index < 125; index += 1) {
		parts.set(`extra-${index}`, {
			...parts.get('c1'),
			primitiveId: `extra-${index}`,
		});
	}
	const largeRead = await toSerializableAsync(await handleSchematicComponentEditTask({ action: 'read' }));
	assert.equal(largeRead.componentCount, 127);
	assert.equal(largeRead.components.length, 127, 'complete snapshots must survive bridge serialization without truncation');
	assert.equal(largeRead.components[0].otherProperty.Value, '10k');
	assert.equal(largeRead.components[0].otherProperty.Datasheet, 'https://example.test/r');
	for (let index = 0; index < 125; index += 1)
		parts.delete(`extra-${index}`);
	await assert.rejects(handleSchematicComponentEditTask({ action: 'read', primitiveId: 'r1' }), /primitiveId is unsupported/);
	const beforeModifyCalls = callCount;
	await assert.rejects(handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: Infinity } }), /finite number/);
	assert.equal(callCount, beforeModifyCalls);
	const modified = await handleSchematicComponentEditTask({
		action: 'modify',
		primitiveId: 'r1',
		property: { x: 150, y: 250, rotation: 180, mirror: true, designator: 'R2', manufacturerId: 'M-2', addIntoBom: false, otherProperty: { Value: '22k' } },
	});
	assert.equal(modified.ok, true);
	assert.equal(modified.verified, true);
	assert.equal(modified.before.designator, 'R1');
	assert.equal(modified.after.designator, 'R2');
	assert.equal(modified.after.x, 150);
	assert.equal(modified.after.y, 250);
	assert.equal(modified.after.rotation, 180);
	assert.equal(modified.after.mirror, true);
	assert.equal(modified.after.addIntoBom, false);
	assert.deepEqual(modified.after.otherProperty, { Value: '22k', Datasheet: 'https://example.test/r' });
	const missing = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'on-another-page', property: { x: 20 } });
	assert.equal(missing.reason, 'component_not_found');
	assert.equal(callCount, beforeModifyCalls + 1);
	const unintendedNet = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: 400, y: 500 } });
	assert.equal(unintendedNet.ok, false);
	assert.equal(unintendedNet.reason, 'pin_network_changed');
	assert.equal(unintendedNet.committed, true);
	assert.equal(unintendedNet.commitUnknown, true);
	assert.deepEqual(unintendedNet.pinNetworkChanges, [{ pinNumber: '1', before: '', after: 'FOREIGN' }]);
	const deleted = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'r1' });
	assert.equal(deleted.ok, true);
	assert.equal(deleted.deleted, true);
	assert.equal(deleted.verified, true);
	assert.equal((await handleSchematicComponentEditTask({ action: 'read' })).componentCount, 1);
	const absent = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'r1' });
	assert.equal(absent.reason, 'component_not_found');

	globalThis.eda.sch_PrimitiveComponent.modify = async () => {
		throw new Error('RPC Call modify Timed Out');
	};
	const nativeTimeout = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 10 } });
	assert.deepEqual([nativeTimeout.commitUnknown, nativeTimeout.readbackRequired, nativeTimeout.nativeCallSettled], [true, true, false]);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, nativeTimeout), true);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, { ...nativeTimeout, nativeCallSettled: true }), false);
	globalThis.eda.sch_PrimitiveComponent.modify = async (id, patch) => {
		Object.assign(parts.get(id), patch);
	};
	const originalGet = globalThis.eda.sch_PrimitiveComponent.get;
	let getCount = 0;
	globalThis.eda.sch_PrimitiveComponent.get = async (...args) => {
		getCount += 1;
		if (getCount === 1)
			return originalGet(...args);
		throw new Error('post-write read unavailable');
	};
	const readbackFailure = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 25 } });
	assert.deepEqual([readbackFailure.commitUnknown, readbackFailure.readbackRequired, readbackFailure.nativeCallSettled], [true, true, true]);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, readbackFailure), false);
	globalThis.eda.sch_PrimitiveComponent.get = originalGet;
	globalThis.eda.sch_PrimitiveComponent.modify = async (id, patch) => {
		Object.assign(parts.get(id), patch);
		pageUuid = 'page-2';
	};
	const pageChanged = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { y: 35 } });
	assert.equal(pageChanged.commitUnknown, true);
	assert.equal(pageChanged.nativeCallSettled, true);
	pageUuid = 'page-1';
	globalThis.eda.sch_PrimitiveComponent.delete = async () => {
		throw new Error('WebSocket connection closed');
	};
	const deleteTimeout = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'c1' });
	assert.deepEqual([deleteTimeout.commitUnknown, deleteTimeout.readbackRequired, deleteTimeout.nativeCallSettled], [true, true, false]);
	console.log('Schematic component edit tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
