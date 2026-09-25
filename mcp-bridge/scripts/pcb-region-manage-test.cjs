const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbRegionManageTask } = require('../src/mcp/pcb-region-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/pcb/region-manage';
const source = ['R', 100, 200, 300, 400, 0, 0];
const complexSource = [source, ['R', 140, 240, 180, 280, 0, 0]];
const regions = new Map();
let page = 'pcb-1';
let serial = 1;
let writes = 0;
let layerLocked = false;

function state(id, patch = {}) {
	return { primitiveId: id, layer: 1, polygonSource: source, ruleType: [2], regionName: null, lineWidth: 0.2, primitiveLock: false, ...patch };
}

function primitive(value) {
	return {
		getState_PrimitiveId: () => value.primitiveId,
		getState_Layer: () => value.layer,
		getState_ComplexPolygon: () => ({ getSource: () => value.polygonSource }),
		getState_RuleType: () => value.ruleType,
		getState_RegionName: () => value.regionName ?? undefined,
		getState_LineWidth: () => value.lineWidth,
		getState_PrimitiveLock: () => value.primitiveLock,
	};
}

async function main() {
	for (let index = 0; index < 130; index++)
		regions.set(`old-${index}`, state(`old-${index}`));
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
		pcb_Layer: { async getAllLayers() { return [{ id: 1, layerStatus: 1, locked: layerLocked }, { id: 12, layerStatus: 1, locked: false }]; } },
		pcb_MathPolygon: {
			createPolygon(value) { return { getSource: () => value }; },
			createComplexPolygon(value) { return { getSource: () => value }; },
		},
		pcb_PrimitiveRegion: {
			async getAll() { return [...regions.values()].map(primitive); },
			async get(id) { return regions.has(id) ? primitive(regions.get(id)) : undefined; },
			async create(layer, polygon, ruleType, regionName, lineWidth, primitiveLock) {
				writes += 1;
				const id = `region-${serial++}`;
				const value = state(id, { layer, polygonSource: polygon.getSource(), ruleType, regionName: regionName ?? null, lineWidth: lineWidth ?? 0.2, primitiveLock: primitiveLock ?? false });
				regions.set(id, value);
				return primitive(value);
			},
			async modify(id, property) {
				writes += 1;
				const patch = { ...property };
				if (patch.complexPolygon) {
					patch.polygonSource = patch.complexPolygon.getSource();
					delete patch.complexPolygon;
				}
				Object.assign(regions.get(id), patch);
				return primitive(regions.get(id));
			},
			async delete(id) {
				writes += 1;
				return regions.delete(id);
			},
		},
	};

	const all = await handlePcbRegionManageTask({ action: 'read' });
	assert.equal(all.complete, true);
	assert.equal(all.regionCount, 130);
	const serialized = await toSerializableAsync(all);
	assert.equal(serialized.regions.length, 130);
	assert.deepEqual(serialized.regions[0].polygonSource, source);
	assert.deepEqual(serialized.regions[0].ruleType, [2]);
	assert.equal((await handlePcbRegionManageTask({ action: 'read', primitiveId: 'old-0' })).found, true);
	assert.equal((await handlePcbRegionManageTask({ action: 'read', primitiveId: 'missing' })).found, false);
	regions.set('complex', state('complex', { polygonSource: complexSource }));
	const complexRead = await toSerializableAsync(await handlePcbRegionManageTask({ action: 'read' }));
	assert.equal(complexRead.regionCount, 131);
	assert.deepEqual(complexRead.regions.find(region => region.primitiveId === 'complex').polygonSource, complexSource);
	const complexModified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'complex', property: { polygonSource: [source, ['R', 145, 245, 185, 285, 0, 0]] } });
	assert.equal(complexModified.verified, true);
	assert.deepEqual(complexModified.region.polygonSource[1], ['R', 145, 245, 185, 285, 0, 0]);
	const createSingle = globalThis.eda.pcb_PrimitiveRegion.create;
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const created = await createSingle(...args);
		const value = regions.get(created.getState_PrimitiveId());
		value.polygonSource = [value.polygonSource];
		return created;
	};
	const normalized = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2] });
	assert.equal(normalized.verified, true);
	assert.deepEqual(normalized.region.polygonSource, [source]);
	globalThis.eda.pcb_PrimitiveRegion.create = createSingle;

	const created = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2, 5], regionName: '禁布区' });
	assert.equal(created.verified, true);
	assert.deepEqual(created.region.ruleType, [2, 5]);
	assert.deepEqual(created.region.polygonSource, source);
	const modified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: created.primitiveId, property: { layer: 12, polygonSource: ['R', 100, 200, 500, 400, 0, 0], ruleType: [9], regionName: '电源约束区', primitiveLock: true } });
	assert.equal(modified.verified, true);
	assert.equal(modified.region.layer, 12);
	assert.deepEqual(modified.region.ruleType, [9]);
	assert.equal(modified.region.regionName, '电源约束区');
	const propertyModify = globalThis.eda.pcb_PrimitiveRegion.modify;
	globalThis.eda.pcb_PrimitiveRegion.modify = async (id, property) => {
		const { lineWidth: _ignored, ...applied } = property;
		return propertyModify(id, applied);
	};
	const partiallyModified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { polygonSource: ['R', 100, 200, 320, 400, 0, 0], lineWidth: 0.3 } });
	assert.equal(partiallyModified.ok, false);
	assert.equal(partiallyModified.applied, true);
	assert.equal(partiallyModified.verified, false);
	assert.equal(partiallyModified.commitUnknown, undefined);
	assert.deepEqual(partiallyModified.requestedMismatches, ['lineWidth']);
	assert.deepEqual(partiallyModified.after.polygonSource, ['R', 100, 200, 320, 400, 0, 0]);
	assert.equal(partiallyModified.after.lineWidth, 0.2);
	globalThis.eda.pcb_PrimitiveRegion.modify = propertyModify;
	const placeholderGet = globalThis.eda.pcb_PrimitiveRegion.get;
	globalThis.eda.pcb_PrimitiveRegion.get = async () => ({ getState_PrimitiveId: () => created.primitiveId });
	const deleted = await handlePcbRegionManageTask({ action: 'delete', primitiveId: created.primitiveId });
	assert.equal(deleted.verified, true);
	assert.equal(deleted.deleted, true);
	assert.equal((await handlePcbRegionManageTask({ action: 'read', primitiveId: created.primitiveId })).found, false);
	globalThis.eda.pcb_PrimitiveRegion.get = placeholderGet;
	const actualDelete = globalThis.eda.pcb_PrimitiveRegion.delete;
	globalThis.eda.pcb_PrimitiveRegion.delete = async () => false;
	const stillPresent = await handlePcbRegionManageTask({ action: 'delete', primitiveId: 'old-1' });
	assert.equal(stillPresent.ok, false);
	assert.equal(stillPresent.reason, 'region_still_present');
	assert.equal(stillPresent.applied, false);
	assert.equal(stillPresent.commitUnknown, undefined);
	globalThis.eda.pcb_PrimitiveRegion.delete = actualDelete;

	const beforeRejected = writes;
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'create', layer: 3, polygonSource: source, ruleType: [2] }), /layer must/);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: complexSource, ruleType: [2] }), /single polygon/);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [] }), /at least one rule/);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { net: 'GND' } }), /Unsupported/);
	layerLocked = true;
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'delete', primitiveId: 'old-0' }), /locked/);
	layerLocked = false;
	assert.equal(writes, beforeRejected);

	const originalModify = globalThis.eda.pcb_PrimitiveRegion.modify;
	globalThis.eda.pcb_PrimitiveRegion.modify = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { primitiveLock: true } });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult(path, {}, unknown), true);
	globalThis.eda.pcb_PrimitiveRegion.modify = originalModify;

	const originalGetAll = globalThis.eda.pcb_PrimitiveRegion.getAll;
	let reads = 0;
	globalThis.eda.pcb_PrimitiveRegion.getAll = async (...args) => {
		reads += 1;
		if (reads === 2)
			throw new Error('readback failed');
		return originalGetAll(...args);
	};
	const readbackUnknown = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { primitiveLock: true } });
	assert.equal(readbackUnknown.commitUnknown, true);
	assert.equal(readbackUnknown.nativeCallSettled, true);
	globalThis.eda.pcb_PrimitiveRegion.getAll = originalGetAll;

	const originalCreate = globalThis.eda.pcb_PrimitiveRegion.create;
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const result = await originalCreate(...args);
		page = 'pcb-2';
		return result;
	};
	const changedPage = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [5] });
	assert.equal(changedPage.commitUnknown, true);
	assert.match(changedPage.error, /active PCB changed/);
	console.log('PCB region management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
