const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { isReadOnlyBridgeRequest } = require('../src/bridge/bridge-contract.ts');
const { enqueueTask } = require('../src/runtime/bridge-runtime.ts');
const {
	markPcbImportPending,
	hasPendingPcbImport,
	getPcbImportWriteRejection,
	handlePcbImportResolveTask,
} = require('../src/runtime/pcb-import-confirm-barrier.ts');

async function main() {
	let currentPageUuid = 'pcb-one';
	globalThis.eda = {
		sys_Storage: { async setExtensionUserConfig() {} },
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: currentPageUuid }; } },
	};
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/import-resolve', {}), true);
	markPcbImportPending('import-1');
	assert.equal(hasPendingPcbImport(), true);
	assert.match(getPcbImportWriteRejection(), /import-1/);
	const results = [];
	const transport = {
		completeTask(requestId, _leaseTerm, _result, error) {
			results.push({ requestId, error });
		},
	};
	for (const [path, payload] of [
		['/bridge/jlceda/pcb/document', { action: 'clear_routing' }],
		['/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.create', args: [] }],
	]) {
		enqueueTask({ requestId: path, path, payload, leaseTerm: 0 }, transport);
		assert.match(results.find(item => item.requestId === path).error.message, /import confirmation is pending/);
	}
	await assert.rejects(() => handlePcbImportResolveTask({ confirm: true, requestId: 'other', resolution: 'applied', expectedPageUuid: 'pcb-one' }), /does not match/);
	currentPageUuid = 'pcb-two';
	await assert.rejects(() => handlePcbImportResolveTask({ confirm: true, requestId: 'import-1', resolution: 'applied', expectedPageUuid: 'pcb-one' }), /does not match/);
	assert.equal(hasPendingPcbImport(), true);
	currentPageUuid = 'pcb-one';
	assert.deepEqual(await handlePcbImportResolveTask({ confirm: true, requestId: 'import-1', resolution: 'cancelled', expectedPageUuid: 'pcb-one' }), {
		ok: true,
		action: 'resolve_import',
		resolution: 'cancelled',
		pageUuid: 'pcb-one',
	});
	assert.equal(hasPendingPcbImport(), false);
	assert.equal(getPcbImportWriteRejection(), undefined);
	process.stdout.write('PCB import confirmation barrier tests passed\n');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
