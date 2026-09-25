const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleEditorNavigateTask } = require('../src/mcp/editor-navigate-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');

const projectUuid = 'project-1';
const tabs = ['page-1@project-1', 'page-2@project-1', 'pcb-1@project-1', 'pcb-2@project-1'];
let activeProjectUuid = projectUuid;
let activeDocumentUuid = 'page-1';
let activeTabId = 'page-1@project-1';
let nativeCalls = 0;

function changeDocument(documentUuid, tabId) {
	activeDocumentUuid = documentUuid;
	activeTabId = tabId;
}

globalThis.eda = {
	dmt_Project: {
		async getCurrentProjectInfo() { return { uuid: activeProjectUuid }; },
	},
	dmt_Schematic: {
		async getAllSchematicsInfo() { return [{ uuid: 'schematic-1', parentProjectUuid: projectUuid }]; },
		async getAllSchematicPagesInfo() {
			return [
				{ uuid: 'page-1', name: 'Schematic1_1', parentSchematicUuid: 'schematic-1' },
				{ uuid: 'page-2', name: 'Schematic1_2', parentSchematicUuid: 'schematic-1' },
				{ uuid: 'foreign-page', name: 'Foreign', parentSchematicUuid: 'other-schematic' },
			];
		},
		async getCurrentSchematicPageInfo() {
			return activeDocumentUuid.startsWith('page-') ? { uuid: activeDocumentUuid } : undefined;
		},
	},
	dmt_Pcb: {
		async getAllPcbsInfo() {
			return [
				{ uuid: 'pcb-1', name: 'PCB1', parentProjectUuid: projectUuid },
				{ uuid: 'pcb-2', name: 'PCB2', parentProjectUuid: projectUuid },
				{ uuid: 'foreign-pcb', name: 'Foreign', parentProjectUuid: 'project-2' },
			];
		},
		async getCurrentPcbInfo() {
			return activeDocumentUuid.startsWith('pcb-') ? { uuid: activeDocumentUuid } : undefined;
		},
	},
	dmt_SelectControl: {
		async getCurrentDocumentInfo() {
			return { uuid: activeDocumentUuid, tabId: activeTabId, parentProjectUuid: activeProjectUuid };
		},
	},
	dmt_EditorControl: {
		async getSplitScreenTree() {
			return { id: 'main', tabs: [{ tabId: tabs[0] }], children: [{ id: 'split', tabs: tabs.slice(1).map(tabId => ({ tabId })) }] };
		},
		async openDocument(documentUuid) {
			nativeCalls += 1;
			const tabId = `${documentUuid}@${projectUuid}`;
			changeDocument(documentUuid, tabId);
			return tabId;
		},
		async activateDocument(tabId) {
			nativeCalls += 1;
			changeDocument(tabId.split('@')[0], tabId);
			return true;
		},
	},
};

async function main() {
	const alreadyActive = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'page-1' });
	assert.equal(alreadyActive.verified, true);
	assert.equal(alreadyActive.changed, false);
	assert.equal(nativeCalls, 0);

	const openedPcb = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'pcb-1' });
	assert.equal(openedPcb.verified, true);
	assert.equal(openedPcb.pageKind, 'pcb');
	assert.equal(openedPcb.tabId, 'pcb-1@project-1');
	assert.equal(openedPcb.pageUuid, 'pcb-1');

	const openedSchematic = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'page-2' });
	assert.equal(openedSchematic.verified, true);
	assert.equal(openedSchematic.pageKind, 'schematic');
	assert.equal(openedSchematic.pageUuid, 'page-2');
	const originalDocumentInfo = globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: activeDocumentUuid, tabId: activeTabId });
	const withoutDocumentProject = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'page-2' });
	assert.equal(withoutDocumentProject.verified, true);
	assert.equal(withoutDocumentProject.changed, false);
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = originalDocumentInfo;

	const activatedPcb = await handleEditorNavigateTask({ operation: 'activate', projectUuid, documentUuid: 'pcb-2', tabId: 'pcb-2@project-1' });
	assert.equal(activatedPcb.verified, true);
	assert.equal(activatedPcb.tabId, 'pcb-2@project-1');

	const beforeRejected = nativeCalls;
	await assert.rejects(() => handleEditorNavigateTask({ operation: 'activate', projectUuid, documentUuid: 'pcb-1', tabId: 'missing' }), /not open/);
	await assert.rejects(() => handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'foreign-pcb' }), /not a schematic page or PCB/);
	await assert.rejects(() => handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'foreign-page' }), /not a schematic page or PCB/);
	activeProjectUuid = 'project-2';
	await assert.rejects(() => handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'pcb-1' }), /active EDA project changed/);
	activeProjectUuid = projectUuid;
	assert.equal(nativeCalls, beforeRejected);

	const originalOpen = globalThis.eda.dmt_EditorControl.openDocument;
	globalThis.eda.dmt_EditorControl.openDocument = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'pcb-1' });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/editor/navigate', {}, unknown), true);
	globalThis.eda.dmt_EditorControl.openDocument = originalOpen;
	globalThis.eda.dmt_EditorControl.openDocument = async (documentUuid) => {
		changeDocument(documentUuid, `${documentUuid}@${projectUuid}`);
		return undefined;
	};
	const appliedWithoutTabResult = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'page-1' });
	assert.equal(appliedWithoutTabResult.verified, true);
	assert.equal(appliedWithoutTabResult.tabId, 'page-1@project-1');
	globalThis.eda.dmt_EditorControl.openDocument = originalOpen;

	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'wrong-document', tabId: 'pcb-1@project-1', parentProjectUuid: projectUuid });
	const mismatched = await handleEditorNavigateTask({ operation: 'open', projectUuid, documentUuid: 'pcb-1' });
	assert.equal(mismatched.commitUnknown, true);
	assert.equal(mismatched.nativeCallSettled, true);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/editor/navigate', {}, mismatched), false);
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = originalDocumentInfo;
	console.log('Editor navigation tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
