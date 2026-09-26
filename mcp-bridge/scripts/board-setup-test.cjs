const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleBoardSetupTask } = require('../src/mcp/board-setup-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');

const projectUuid = 'project-a';
const schematics = new Map([
	['existing-sch', { uuid: 'existing-sch', name: 'Existing', parentProjectUuid: projectUuid }],
	['linked-sch', { uuid: 'linked-sch', name: 'Linked', parentProjectUuid: projectUuid, parentBoardName: 'OldBoard' }],
	['foreign-sch', { uuid: 'foreign-sch', name: 'Foreign', parentProjectUuid: 'project-b' }],
]);
const pcbs = new Map();
const boards = new Map();
let currentProjectUuid = projectUuid;
let boardSequence = 0;
let pcbSequence = 0;
const boardCalls = [];

globalThis.eda = {
	dmt_Project: { async getCurrentProjectInfo() { return { uuid: currentProjectUuid }; } },
	dmt_Schematic: { async getSchematicInfo(uuid) { return schematics.get(uuid); } },
	dmt_Pcb: {
		async getPcbInfo(uuid) { return pcbs.get(uuid); },
		async getAllPcbsInfo() { return [...pcbs.values()]; },
		async createPcb() {
			const uuid = `created-pcb-${++pcbSequence}`;
			pcbs.set(uuid, { uuid, name: uuid, parentProjectUuid: projectUuid });
			return uuid;
		},
	},
	dmt_Board: {
		async getBoardInfo(name) { return boards.get(name); },
		async getAllBoardsInfo() { return [...boards.values()]; },
		async createBoard(...args) {
			boardCalls.push(args);
			const name = `Board-${++boardSequence}`;
			let [schematicUuid, pcbUuid] = args;
			if (args.length === 0) {
				schematicUuid = `auto-sch-${boardSequence}`;
				pcbUuid = `auto-pcb-${boardSequence}`;
				schematics.set(schematicUuid, { uuid: schematicUuid, name: schematicUuid, parentProjectUuid: projectUuid });
				pcbs.set(pcbUuid, { uuid: pcbUuid, name: pcbUuid, parentProjectUuid: projectUuid });
			}
			schematics.get(schematicUuid).parentBoardName = name;
			pcbs.get(pcbUuid).parentBoardName = name;
			boards.set(name, { name, parentProjectUuid: projectUuid, schematic: schematics.get(schematicUuid), pcb: pcbs.get(pcbUuid) });
			return name;
		},
	},
};

async function main() {
	const nativeSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args);
	try {
		await assert.rejects(() => handleBoardSetupTask({ projectUuid }), /confirm/);
		currentProjectUuid = 'project-b';
		await assert.rejects(() => handleBoardSetupTask({ projectUuid, confirm: true }), /active EDA project changed/);
		currentProjectUuid = projectUuid;
		await assert.rejects(() => handleBoardSetupTask({ projectUuid, schematicUuid: 'foreign-sch', confirm: true }), /current project/);
		await assert.rejects(() => handleBoardSetupTask({ projectUuid, schematicUuid: 'linked-sch', confirm: true }), /already associated/);
		assert.equal(boardCalls.length, 0);

		const automatic = await handleBoardSetupTask({ projectUuid, confirm: true });
		assert.equal(automatic.ok, true);
		assert.equal(automatic.verified, true);
		assert.deepEqual(boardCalls[0], []);
		assert.equal(automatic.board.schematicUuid, automatic.schematicUuid);
		assert.equal(automatic.board.pcbUuid, automatic.pcbUuid);
		assert.equal(automatic.pcb.parentBoardName, automatic.boardName);

		const associated = await handleBoardSetupTask({ projectUuid, schematicUuid: 'existing-sch', confirm: true });
		assert.equal(associated.ok, true);
		assert.equal(associated.schematicUuid, 'existing-sch');
		assert.equal(associated.createdPcbUuid, associated.pcbUuid);
		assert.deepEqual(boardCalls[1], ['existing-sch', associated.pcbUuid]);
		assert.equal(schematics.get('existing-sch').parentBoardName, associated.boardName);

		schematics.set('unlinked-sch', { uuid: 'unlinked-sch', name: 'Unlinked', parentProjectUuid: projectUuid });
		const nativeCreateBoard = globalThis.eda.dmt_Board.createBoard;
		globalThis.eda.dmt_Board.createBoard = async () => undefined;
		const rejected = await handleBoardSetupTask({ projectUuid, schematicUuid: 'unlinked-sch', confirm: true });
		assert.equal(rejected.reason, 'native_rejected');
		assert.equal(rejected.stage, 'create_board');
		assert.equal(rejected.readbackRequired, true);
		assert.equal(pcbs.get(rejected.createdPcbUuid).parentBoardName, undefined);
		globalThis.eda.dmt_Board.createBoard = async () => {
			throw new Error('Cannot link documents');
		};
		const failed = await handleBoardSetupTask({ projectUuid, schematicUuid: 'unlinked-sch', confirm: true });
		assert.equal(failed.reason, 'native_rejected');
		assert.equal(failed.readbackRequired, true);
		assert.equal(pcbs.get(failed.createdPcbUuid).parentBoardName, undefined);
		globalThis.eda.dmt_Board.createBoard = async () => {
			throw new Error('RPC Call Timed Out');
		};
		const boardUnknown = await handleBoardSetupTask({ projectUuid, schematicUuid: 'unlinked-sch', confirm: true });
		assert.equal(boardUnknown.stage, 'create_board');
		assert.equal(boardUnknown.commitUnknown, true);
		assert.equal(boardUnknown.nativeCallSettled, false);
		assert.equal(pcbs.get(boardUnknown.createdPcbUuid).parentBoardName, undefined);
		globalThis.eda.dmt_Board.createBoard = nativeCreateBoard;

		const nativeCreatePcb = globalThis.eda.dmt_Pcb.createPcb;
		globalThis.eda.dmt_Pcb.createPcb = async () => {
			throw new Error('RPC Call Timed Out');
		};
		const unknown = await handleBoardSetupTask({ projectUuid, schematicUuid: 'unlinked-sch', confirm: true });
		assert.equal(unknown.stage, 'create_pcb');
		assert.equal(unknown.commitUnknown, true);
		assert.equal(unknown.nativeCallSettled, false);
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/board/setup', {}, unknown), true);
		globalThis.eda.dmt_Pcb.createPcb = nativeCreatePcb;

		const nativeGetBoardInfo = globalThis.eda.dmt_Board.getBoardInfo;
		globalThis.eda.dmt_Board.getBoardInfo = async () => {
			throw new Error('readback failed');
		};
		const readbackFailure = await handleBoardSetupTask({ projectUuid, confirm: true });
		assert.equal(readbackFailure.stage, 'verify_board');
		assert.equal(readbackFailure.commitUnknown, true);
		assert.equal(readbackFailure.nativeCallSettled, true);
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/board/setup', {}, readbackFailure), false);
		globalThis.eda.dmt_Board.getBoardInfo = nativeGetBoardInfo;
		console.log('Board setup tests passed');
	}
	finally {
		globalThis.setTimeout = nativeSetTimeout;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
