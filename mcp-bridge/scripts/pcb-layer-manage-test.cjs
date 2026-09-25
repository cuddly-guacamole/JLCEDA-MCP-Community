const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbLayerManageTask } = require('../src/mcp/pcb-layer-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

// EDA 3.2.181 exposes the unused inner copper-layer slots with layerStatus 0.
const copperLayerSlots = 34;
let page = 'pcb-layer-page';
let copperLayerCount = 2;
let setCalls = 0;
let setMode = 'success';
let readbackFails = false;
let extraLayerCount = 0;
let reportedCopperLayerCount;
let omitLayerStatus = false;
const primitiveApis = [
	'pcb_PrimitiveLine',
	'pcb_PrimitiveArc',
	'pcb_PrimitivePolyline',
	'pcb_PrimitiveFill',
	'pcb_PrimitivePour',
	'pcb_PrimitivePad',
	'pcb_PrimitiveRegion',
	'pcb_PrimitiveString',
	'pcb_PrimitiveAttribute',
	'pcb_PrimitiveImage',
	'pcb_PrimitiveDimension',
	'pcb_PrimitiveObject',
];
const primitiveInventories = new Map();

globalThis.eda = {
	dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
	pcb_Layer: {
		async getTheNumberOfCopperLayers() {
			if (readbackFails)
				throw new Error('readback failed');
			return copperLayerCount;
		},
		async getAllLayers() {
			const count = reportedCopperLayerCount ?? copperLayerCount;
			return Array.from({ length: copperLayerSlots + extraLayerCount }, (_item, index) => ({
				id: index < 2 ? index + 1 : index + 13,
				type: index < copperLayerSlots ? (index === 2 ? 'PLANE' : 'SIGNAL') : 'CUSTOM',
				...(!omitLayerStatus && { layerStatus: index < copperLayerSlots && index >= count ? 0 : index === 2 ? 2 : 1 }),
				name: `Layer ${index + 1}`,
			}));
		},
		async setTheNumberOfCopperLayers(count) {
			setCalls += 1;
			if (setMode === 'timeout')
				throw new Error('RPC Call setTheNumberOfCopperLayers Timed Out');
			if (setMode === 'reject')
				return false;
			const previousCount = copperLayerCount;
			copperLayerCount = count;
			if (setMode === 'stale-layers')
				reportedCopperLayerCount = previousCount;
			if (setMode === 'readback-fails')
				readbackFails = true;
			if (setMode === 'switch-page')
				page = 'another-page';
			return true;
		},
	},
};
for (const apiName of primitiveApis) {
	globalThis.eda[apiName] = {
		async getAll() {
			return primitiveInventories.get(apiName) ?? [];
		},
	};
}

async function main() {
	const read = await handlePcbLayerManageTask({ action: 'read' });
	assert.equal(read.complete, true);
	assert.equal(read.pageUuid, 'pcb-layer-page');
	assert.equal(read.copperLayerCount, 2);
	assert.equal(read.layerCount, copperLayerSlots);
	assert.equal(read.layers.filter(layer => (layer.type === 'SIGNAL' || layer.type === 'PLANE') && layer.layerStatus === 0).length, 32);
	extraLayerCount = 130;
	const completeRead = await toSerializableAsync(await handlePcbLayerManageTask({ action: 'read' }));
	assert.equal(completeRead.layers.length, copperLayerSlots + 130, 'the complete layer list must survive final Bridge serialization');
	extraLayerCount = 0;
	await assert.rejects(() => handlePcbLayerManageTask({ action: 'set', copperLayerCount: 4 }), /confirm must be true/);
	assert.equal(setCalls, 0, 'missing confirmation must stop before the native setter');
	const noChange = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 2 });
	assert.equal(noChange.verified, true);
	assert.equal(noChange.changed, false);
	assert.equal(setCalls, 0);
	const set = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 4 });
	assert.equal(set.ok, true);
	assert.equal(set.verified, true);
	assert.equal(set.previousCopperLayerCount, 2);
	assert.equal(set.copperLayerCount, 4);
	assert.equal(set.layerCount, copperLayerSlots);
	assert.equal(set.layers[2].type, 'PLANE');
	assert.equal(set.layers[2].layerStatus, 2);
	assert.equal(setCalls, 1);
	primitiveInventories.set('pcb_PrimitiveLine', [{ getState_Layer: () => 15, getState_PrimitiveId: () => 'inner-track' }]);
	const blocked = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 2 });
	assert.equal(blocked.reason, 'removed_layer_not_empty');
	assert.deepEqual(blocked.blockingPrimitive, { apiName: 'pcb_PrimitiveLine', primitiveId: 'inner-track', layer: 15 });
	assert.equal(blocked.changed, false);
	assert.equal(setCalls, 1, 'a populated inner layer must never reach the native setter');
	primitiveInventories.delete('pcb_PrimitiveLine');
	setMode = 'reject';
	const rejected = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 2 });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, 'native_rejected');
	assert.equal(rejected.verified, true);
	assert.equal(rejected.copperLayerCount, 4);
	setMode = 'timeout';
	const timedOut = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 6 });
	assert.equal(timedOut.commitUnknown, true);
	assert.equal(timedOut.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/pcb/layer-manage', {}, timedOut), true);
	setMode = 'readback-fails';
	const readbackUnknown = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 6 });
	assert.equal(readbackUnknown.commitUnknown, true);
	assert.equal(readbackUnknown.nativeCallSettled, true);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/pcb/layer-manage', {}, readbackUnknown), false);
	readbackFails = false;
	setMode = 'switch-page';
	const changedPage = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 8 });
	assert.equal(changedPage.commitUnknown, true);
	assert.equal(changedPage.nativeCallSettled, true);
	page = 'pcb-layer-page';
	setMode = 'stale-layers';
	const staleLayerList = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 10 });
	assert.equal(staleLayerList.commitUnknown, true);
	assert.equal(staleLayerList.nativeCallSettled, true);
	assert.match(staleLayerList.error, /disagrees with the enabled/);
	await assert.rejects(() => handlePcbLayerManageTask({ action: 'read' }), /disagrees with the enabled/);
	reportedCopperLayerCount = undefined;
	omitLayerStatus = true;
	await assert.rejects(() => handlePcbLayerManageTask({ action: 'read' }), /readback is incomplete/);
	omitLayerStatus = false;
	setMode = 'success';
	primitiveInventories.set('pcb_PrimitiveLine', [{ getState_Layer: () => 15, getState_PrimitiveId: () => 'retained-track' }]);
	const retained = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 6 });
	assert.equal(retained.verified, true, 'a populated inner layer that remains enabled does not block reduction');
	primitiveInventories.delete('pcb_PrimitiveLine');
	const emptyReduction = await handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: 2 });
	assert.equal(emptyReduction.verified, true, 'empty inner layers can be removed');
	const calls = setCalls;
	for (const invalid of [1, 3, 34, 4.5])
		await assert.rejects(() => handlePcbLayerManageTask({ action: 'set', confirm: true, copperLayerCount: invalid }), /even integer/);
	assert.equal(setCalls, calls);
	process.stdout.write('PCB copper-layer management tests passed\n');
}

main().catch((error) => {
	process.stderr.write(`${error.stack ?? error}\n`);
	process.exitCode = 1;
});
