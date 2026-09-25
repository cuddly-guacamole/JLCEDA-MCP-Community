const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicTextManageTask } = require('../src/mcp/schematic-text-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const texts = new Map();
let page = 'schematic-text-page';
let document = page;
let serial = 1;
let writes = 0;
let lastCreateArgs;
let afterDonePage;

function state(id, patch = {}) {
	return { primitiveId: id, x: 100, y: 200, content: 'Note', rotation: 0, textColor: null, fontName: null, fontSize: null, bold: null, italic: null, underLine: null, alignMode: 1, ...patch };
}

function primitive(value) {
	const result = Object.fromEntries(Object.entries(value).map(([field, item]) => {
		const name = field === 'primitiveId' ? 'PrimitiveId' : field[0].toUpperCase() + field.slice(1);
		return [`getState_${name}`, () => item];
	}));
	const changes = {};
	result.toAsync = () => result;
	for (const field of ['x', 'y', 'content', 'rotation', 'textColor', 'fontName', 'fontSize', 'bold', 'italic', 'underLine']) {
		const name = field[0].toUpperCase() + field.slice(1);
		result[`setState_${name}`] = (item) => {
			changes[field] = item;
			return result;
		};
	}
	result.done = async () => {
		writes += 1;
		Object.assign(texts.get(value.primitiveId), changes);
		if (afterDonePage) {
			page = afterDonePage;
			document = page;
		}
		return primitive(texts.get(value.primitiveId));
	};
	return result;
}

async function main() {
	for (let index = 0; index < 130; index++)
		texts.set(`text-${index}`, state(`text-${index}`));
	const native = {
		async getAll() { return [...texts.values()].map(primitive); },
		async getAllPrimitiveId() { return [...texts.keys()]; },
		async get(id) { return texts.has(id) ? primitive(texts.get(id)) : undefined; },
		async create(...args) {
			writes += 1;
			lastCreateArgs = args;
			const [x, y, content, rotation = 0, textColor = null, fontName = null, fontSize = null, bold = null, italic = null, underLine = null, alignMode = 1] = args;
			const id = `created-${serial++}`;
			texts.set(id, state(id, { x, y, content, rotation, textColor, fontName, fontSize, bold, italic, underLine, alignMode }));
			return primitive(texts.get(id));
		},
		async modify(id, property) {
			writes += 1;
			Object.assign(texts.get(id), { alignMode: 3 }, property);
			return primitive(texts.get(id));
		},
		async delete(id) {
			writes += 1;
			return texts.delete(id);
		},
	};
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: page }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: document }; } },
		sch_PrimitiveText: native,
	};
	const all = await handleSchematicTextManageTask({ action: 'read' });
	assert.equal(all.complete, true);
	assert.equal(all.textCount, 130);
	assert.equal(all.texts[0].bold, false);
	assert.equal(all.texts[0].italic, false);
	assert.equal(all.texts[0].underLine, false);
	assert.equal((await toSerializableAsync(all)).texts.length, 130);
	assert.equal((await handleSchematicTextManageTask({ action: 'read', primitiveId: 'text-0' })).found, true);
	assert.equal((await handleSchematicTextManageTask({ action: 'read', primitiveId: 'absent' })).found, false);
	const originalGet = native.get;
	native.get = async () => undefined;
	assert.equal((await handleSchematicTextManageTask({ action: 'read', primitiveId: 'text-0' })).found, true);
	native.get = originalGet;

	const created = await handleSchematicTextManageTask({ action: 'create', x: 500, y: 600, content: 'Revision A', bold: true });
	assert.deepEqual(lastCreateArgs.slice(3), [0, null, null, null, true, false, false, undefined]);
	assert.equal(created.verified, true);
	assert.equal(created.text.content, 'Revision A');
	assert.equal(created.text.bold, true);
	assert.equal(created.text.italic, false);
	assert.equal(created.text.underLine, false);
	const contentOnly = await handleSchematicTextManageTask({ action: 'modify', primitiveId: created.primitiveId, property: { content: 'Revision A2' } });
	assert.equal(contentOnly.verified, true);
	assert.equal(contentOnly.text.alignMode, 1);
	const changed = await handleSchematicTextManageTask({ action: 'modify', primitiveId: created.primitiveId, property: { content: 'Revision B', x: 700, textColor: '#ff0000', fontSize: 20 } });
	assert.equal(changed.verified, true);
	assert.equal(changed.text.content, 'Revision B');
	assert.equal(changed.text.x, 700);
	assert.equal(changed.text.alignMode, 1);
	const deleted = await handleSchematicTextManageTask({ action: 'delete', primitiveId: created.primitiveId });
	assert.equal(deleted.verified, true);
	assert.equal(deleted.deleted, true);

	const beforeInvalid = writes;
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'create', x: 1, y: 2 }), /required/);
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'modify', primitiveId: 'text-0', property: {} }), /non-empty/);
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'modify', primitiveId: 'text-0', property: { net: 'GND' } }), /Unsupported/);
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'create', x: 1, y: 2, content: 'Note', alignMode: 6 }), /cannot reliably write/);
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'modify', primitiveId: 'text-0', property: { alignMode: 6 } }), /cannot reliably write/);
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'modify', primitiveId: 'text-0', property: { rotation: 45 } }), /rotation/);
	assert.equal(writes, beforeInvalid);

	document = 'another-page';
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'delete', primitiveId: 'text-0' }), /not synchronized/);
	assert.equal(writes, beforeInvalid);
	document = page;

	const originalCreate = native.create;
	native.create = async (...args) => {
		await originalCreate(...args);
		throw new Error('ETIMEDOUT');
	};
	const unknown = await handleSchematicTextManageTask({ action: 'create', x: 50, y: 60, content: 'Possibly created' });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/text-manage', { action: 'create' }, unknown), true);
	native.create = originalCreate;

	afterDonePage = 'different-page';
	const uncertainReadback = await handleSchematicTextManageTask({ action: 'modify', primitiveId: 'text-0', property: { content: 'Changed on old page' } });
	assert.equal(uncertainReadback.commitUnknown, true);
	assert.equal(uncertainReadback.nativeCallSettled, true);
	page = 'schematic-text-page';
	document = page;
	afterDonePage = undefined;

	page = 'next-page';
	document = page;
	const copiedPage = await handleSchematicTextManageTask({ action: 'read', primitiveId: 'text-0' });
	assert.equal(copiedPage.found, true, 'copied pages may reuse text IDs');
	assert.equal(copiedPage.pageUuid, 'next-page');
	const originalGetAllPrimitiveId = native.getAllPrimitiveId;
	native.getAllPrimitiveId = async () => ['different-page-text'];
	const beforeStaleWrite = writes;
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'read' }), /list changed/);
	await assert.rejects(() => handleSchematicTextManageTask({ action: 'modify', primitiveId: 'text-0', property: { content: 'Wrong page' } }), /list changed/);
	assert.equal(writes, beforeStaleWrite);
	native.getAllPrimitiveId = originalGetAllPrimitiveId;
	console.log('schematic_text_manage handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
