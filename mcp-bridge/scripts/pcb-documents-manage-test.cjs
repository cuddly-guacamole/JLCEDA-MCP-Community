const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbDocumentsManageTask } = require('../src/mcp/pcb-documents-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const projectUuid = 'project-a';
const documents = new Map();
for (let index = 0; index < 125; index++) {
	const uuid = `old-${index}`;
	documents.set(uuid, { itemType: 'PCB', uuid, name: `PCB_${index}`, parentProjectUuid: projectUuid });
}
documents.set('other-project', { itemType: 'PCB', uuid: 'other-project', name: 'Other', parentProjectUuid: 'project-b' });
documents.get('old-0').parentBoardName = null;
let currentProjectUuid = projectUuid;
let currentPcbUuid = 'old-0';
let writes = 0;
let sequence = 1;

globalThis.eda = {
	dmt_Project: { async getCurrentProjectInfo() { return { uuid: currentProjectUuid }; } },
	dmt_Pcb: {
		async getCurrentPcbInfo() { return documents.get(currentPcbUuid); },
		async getAllPcbsInfo() { return [...documents.values()]; },
		async getPcbInfo(uuid) { return documents.get(uuid); },
		async createPcb(boardName) {
			writes += 1;
			const uuid = `created-${sequence++}`;
			documents.set(uuid, { itemType: 'PCB', uuid, name: `PCB_${uuid}`, parentProjectUuid: projectUuid, ...(boardName ? { parentBoardName: boardName } : {}) });
			return uuid;
		},
		async copyPcb(sourceUuid, boardName) {
			writes += 1;
			const uuid = `copied-${sequence++}`;
			documents.set(uuid, { ...documents.get(sourceUuid), uuid, name: `PCB_${uuid}`, ...(boardName ? { parentBoardName: boardName } : { parentBoardName: undefined }) });
			return uuid;
		},
		async modifyPcbName(uuid, name) {
			writes += 1;
			documents.get(uuid).name = name.toLowerCase();
			return true;
		},
	},
};

async function main() {
	const list = await handlePcbDocumentsManageTask({ operation: 'list', projectUuid });
	assert.equal(list.complete, true);
	assert.equal(list.pcbCount, 125);
	assert.equal((await toSerializableAsync(list)).pcbs.length, 125);
	assert.equal(list.pcbs.some(pcb => pcb.uuid === 'other-project'), false);

	const beforeRejected = writes;
	await assert.rejects(() => handlePcbDocumentsManageTask({ operation: 'create', projectUuid }), /confirm/);
	await assert.rejects(() => handlePcbDocumentsManageTask({ operation: 'copy', projectUuid, pcbUuid: 'other-project', confirm: true }), /does not belong/);
	const originalGetPcbInfo = globalThis.eda.dmt_Pcb.getPcbInfo;
	globalThis.eda.dmt_Pcb.getPcbInfo = async () => documents.get('old-1');
	await assert.rejects(() => handlePcbDocumentsManageTask({ operation: 'copy', projectUuid, pcbUuid: 'old-0', confirm: true }), /returned PCB old-1 for requested PCB old-0/);
	globalThis.eda.dmt_Pcb.getPcbInfo = originalGetPcbInfo;
	currentProjectUuid = 'project-b';
	await assert.rejects(() => handlePcbDocumentsManageTask({ operation: 'create', projectUuid, confirm: true }), /active EDA project changed/);
	currentProjectUuid = projectUuid;
	assert.equal(writes, beforeRejected);

	const created = await handlePcbDocumentsManageTask({ operation: 'create', projectUuid, confirm: true });
	assert.equal(created.verified, true);
	assert.equal(created.pcb.parentBoardName, null);
	assert.equal(created.pcb.parentProjectUuid, projectUuid);
	const copied = await handlePcbDocumentsManageTask({ operation: 'copy', projectUuid, pcbUuid: created.pcbUuid, boardName: 'Board1', confirm: true });
	assert.equal(copied.verified, true);
	assert.notEqual(copied.pcbUuid, created.pcbUuid);
	assert.equal(copied.pcb.parentBoardName, 'Board1');

	await assert.rejects(() => handlePcbDocumentsManageTask({ operation: 'rename', projectUuid, pcbUuid: copied.pcbUuid, newName: 'TEST_PCB', confirm: true }), /Open the target PCB/);
	currentPcbUuid = copied.pcbUuid;
	const renamed = await handlePcbDocumentsManageTask({ operation: 'rename', projectUuid, pcbUuid: copied.pcbUuid, newName: 'TEST_PCB', confirm: true });
	assert.equal(renamed.verified, true);
	assert.equal(renamed.pcb.name, 'test_pcb');
	assert.equal(writes, beforeRejected + 3);

	const originalCopy = globalThis.eda.dmt_Pcb.copyPcb;
	globalThis.eda.dmt_Pcb.copyPcb = async () => undefined;
	const rejected = await handlePcbDocumentsManageTask({ operation: 'copy', projectUuid, pcbUuid: created.pcbUuid, confirm: true });
	assert.equal(rejected.reason, 'native_rejected');
	assert.equal(rejected.changed, false);
	globalThis.eda.dmt_Pcb.copyPcb = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handlePcbDocumentsManageTask({ operation: 'copy', projectUuid, pcbUuid: created.pcbUuid, confirm: true });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/pcb/documents-manage', {}, unknown), true);
	globalThis.eda.dmt_Pcb.copyPcb = originalCopy;

	const originalGetAll = globalThis.eda.dmt_Pcb.getAllPcbsInfo;
	let readCount = 0;
	globalThis.eda.dmt_Pcb.getAllPcbsInfo = async () => {
		readCount += 1;
		if (readCount === 2)
			throw new Error('readback failed');
		return originalGetAll();
	};
	const failedReadback = await handlePcbDocumentsManageTask({ operation: 'create', projectUuid, confirm: true });
	assert.equal(failedReadback.commitUnknown, true);
	assert.equal(failedReadback.nativeCallSettled, true);
	globalThis.eda.dmt_Pcb.getAllPcbsInfo = originalGetAll;
	console.log('PCB document management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
