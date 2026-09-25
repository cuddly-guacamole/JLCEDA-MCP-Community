const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbTextManageTask } = require('../src/mcp/pcb-text-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const strings = new Map();
const attributes = new Map();
let page = 'pcb-text-page';
let writes = 0;
let serial = 1;

function stringState(id, patch = {}) {
	return { primitiveId: id, layer: 3, x: 100, y: 200, text: 'Version 1', fontFamily: 'default', fontSize: 45, lineWidth: 6, alignMode: 3, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false, ...patch };
}

function attributeState(id, patch = {}) {
	const { text, ...common } = stringState(id);
	return { ...common, parentPrimitiveId: 'component-1', key: 'Designator', value: 'U1', keyVisible: false, valueVisible: true, ...patch };
}

function primitive(value) {
	return Object.fromEntries(Object.entries(value).map(([field, item]) => {
		const name = field === 'primitiveId'
			? 'PrimitiveId'
			: field === 'parentPrimitiveId'
				? 'ParentPrimitiveId'
				: field[0].toUpperCase() + field.slice(1);
		return [`getState_${name}`, () => item];
	}));
}

async function main() {
	for (let index = 0; index < 130; index++) {
		strings.set(`s-${index}`, stringState(`s-${index}`));
		attributes.set(`a-${index}`, attributeState(`a-${index}`));
	}
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
		pcb_Layer: { async getAllLayers() { return [1, 3, 4, 13].map(id => ({ id, layerStatus: 1, locked: false })); } },
		pcb_PrimitiveComponent: { async get(id) { return id === 'component-1' ? { id } : undefined; } },
		pcb_PrimitiveString: {
			async getAll() { return [...strings.values()].map(primitive); },
			async get(id) { return strings.has(id) ? primitive(strings.get(id)) : undefined; },
			async create(layer, x, y, text, fontFamily, fontSize, lineWidth, alignMode, rotation, reverse, expansion, mirror, primitiveLock) {
				writes += 1;
				const id = `created-${serial++}`;
				strings.set(id, stringState(id, { layer, x, y, text, fontFamily, fontSize, lineWidth, alignMode, rotation, reverse, expansion, mirror, primitiveLock }));
				return primitive(strings.get(id));
			},
			async modify(id, property) {
				writes += 1;
				Object.assign(strings.get(id), property);
				return primitive(strings.get(id));
			},
			async delete(id) {
				writes += 1;
				return strings.delete(id);
			},
		},
		pcb_PrimitiveAttribute: {
			async getAll(parentId) { return [...attributes.values()].filter(item => !parentId || item.parentPrimitiveId === parentId).map(primitive); },
			async get(id) { return attributes.has(id) ? primitive(attributes.get(id)) : undefined; },
			async modify(id, property) {
				writes += 1;
				Object.assign(attributes.get(id), property);
				return primitive(attributes.get(id));
			},
		},
	};

	const all = await handlePcbTextManageTask({ action: 'read' });
	assert.equal(all.complete, true);
	assert.equal(all.stringCount, 130);
	assert.equal(all.attributeCount, 130);
	const serialized = await toSerializableAsync(all);
	assert.equal(serialized.strings.length, 130);
	assert.equal(serialized.attributes.length, 130);
	assert.equal((await handlePcbTextManageTask({ action: 'read', kind: 'string', primitiveId: 's-0' })).found, true);
	assert.equal((await handlePcbTextManageTask({ action: 'read', kind: 'attribute', primitiveId: 'absent' })).found, false);
	assert.equal((await handlePcbTextManageTask({ action: 'read', kind: 'attribute', parentPrimitiveId: 'component-1' })).attributeCount, 130);

	const created = await handlePcbTextManageTask({ action: 'create', kind: 'string', layer: 3, x: 500, y: 600, text: 'Revision A' });
	assert.equal(created.verified, true);
	assert.equal(created.item.text, 'Revision A');
	assert.equal(created.item.fontSize, 45);
	const modified = await handlePcbTextManageTask({ action: 'modify', kind: 'string', primitiveId: created.primitiveId, property: { text: 'Revision B', layer: 4, x: 700, alignMode: 5 } });
	assert.equal(modified.verified, true);
	assert.equal(modified.item.text, 'Revision B');
	assert.equal(modified.item.layer, 4);
	const attribute = await handlePcbTextManageTask({ action: 'modify', kind: 'attribute', primitiveId: 'a-0', parentPrimitiveId: 'component-1', property: { value: 'U2', valueVisible: false, fontSize: 60 } });
	assert.equal(attribute.verified, true);
	assert.equal(attribute.item.value, 'U2');
	assert.equal(attribute.item.valueVisible, false);
	const deleted = await handlePcbTextManageTask({ action: 'delete', kind: 'string', primitiveId: created.primitiveId });
	assert.equal(deleted.verified, true);
	assert.equal(deleted.deleted, true);

	const beforeRejected = writes;
	await assert.rejects(() => handlePcbTextManageTask({ action: 'create', kind: 'attribute' }), /Only standalone/);
	await assert.rejects(() => handlePcbTextManageTask({ action: 'delete', kind: 'attribute', primitiveId: 'a-0' }), /Only standalone/);
	await assert.rejects(() => handlePcbTextManageTask({ action: 'modify', kind: 'attribute', primitiveId: 'a-0', parentPrimitiveId: 'wrong', property: { value: 'U3' } }), /does not belong/);
	await assert.rejects(() => handlePcbTextManageTask({ action: 'modify', kind: 'string', primitiveId: 's-0', property: { net: 'GND' } }), /Unsupported/);
	await assert.rejects(() => handlePcbTextManageTask({ action: 'create', kind: 'string', layer: 7, x: 0, y: 0, text: 'Bad' }), /layer must/);
	assert.equal(writes, beforeRejected);

	const originalModify = globalThis.eda.pcb_PrimitiveString.modify;
	globalThis.eda.pcb_PrimitiveString.modify = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handlePcbTextManageTask({ action: 'modify', kind: 'string', primitiveId: 's-0', property: { text: 'Unknown' } });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/pcb/text-manage', {}, unknown), true);
	globalThis.eda.pcb_PrimitiveString.modify = originalModify;

	const originalGet = globalThis.eda.pcb_PrimitiveString.get;
	let reads = 0;
	globalThis.eda.pcb_PrimitiveString.get = async (...args) => {
		reads += 1;
		if (reads === 2)
			throw new Error('readback failed');
		return originalGet(...args);
	};
	const readbackUnknown = await handlePcbTextManageTask({ action: 'modify', kind: 'string', primitiveId: 's-0', property: { text: 'Changed' } });
	assert.equal(readbackUnknown.commitUnknown, true);
	assert.equal(readbackUnknown.nativeCallSettled, true);
	globalThis.eda.pcb_PrimitiveString.get = originalGet;

	const originalCreate = globalThis.eda.pcb_PrimitiveString.create;
	globalThis.eda.pcb_PrimitiveString.create = async (...args) => {
		const result = await originalCreate(...args);
		page = 'another-pcb';
		return result;
	};
	const changedPage = await handlePcbTextManageTask({ action: 'create', kind: 'string', layer: 3, x: 10, y: 20, text: 'Moved' });
	assert.equal(changedPage.commitUnknown, true);
	assert.match(changedPage.error, /active PCB changed/);
	console.log('PCB text management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
