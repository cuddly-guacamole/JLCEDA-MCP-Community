const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let activeTransport;
const transportReady = deferred();
class MockBridgeTransport {
	constructor(_url, _socketId, clientId, _version, _context, callbacks) {
		this.clientId = clientId;
		this.callbacks = callbacks;
		this.results = new Map();
		this.resultWaiters = new Map();
		this.started = [];
		this.startedContexts = new Map();
		activeTransport = this;
	}

	async connect() {
		this.callbacks.onRoleChanged({
			type: 'bridge/role',
			clientId: this.clientId,
			activeClientId: this.clientId,
			role: 'active',
			leaseTerm: 1,
		});
		transportReady.resolve();
	}

	completeTask(requestId, _leaseTerm, result, error) {
		this.beforeComplete?.(requestId);
		const response = { result, error };
		this.results.set(requestId, response);
		this.resultWaiters.get(requestId)?.resolve(response);
	}

	resultFor(requestId) {
		if (this.results.has(requestId))
			return Promise.resolve(this.results.get(requestId));
		const waiter = deferred();
		this.resultWaiters.set(requestId, waiter);
		return waiter.promise;
	}

	reportTaskStarted(requestId, _leaseTerm, context) {
		this.started.push(requestId);
		this.startedContexts.set(requestId, context);
	}

	refreshServerActivity() {}
	reportReady() {}
	updateContext() {}
	close() {}
}

// Keep the real runtime, route registry, and API handler; replace only the socket transport.
require('../src/runtime/bridge-transport.ts').BridgeTransport = MockBridgeTransport;
const { enqueueTask, startBridgeRuntime, stopBridgeRuntime } = require('../src/runtime/bridge-runtime.ts');

async function main() {
	const deleteEntered = deferred();
	const finishDelete = deferred();
	let idReads = 0;
	let deleteCalls = 0;
	let secondWriteCalls = 0;
	let readCalls = 0;
	let pcbWriteCalls = 0;
	let currentDocumentType = 3;
	globalThis.eda = {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1, PCB: 3 },
		sys_Storage: { getExtensionUserConfig() { return undefined; }, async setExtensionUserConfig() {} },
		sys_MessageBus: {
			subscribe() { return { running: () => true, cancel() {} }; },
			publish() {},
		},
		sys_Message: { showToastMessage() {} },
		dmt_SelectControl: {
			async getCurrentDocumentInfo() {
				return {
					uuid: currentDocumentType === 3 ? 'pcb-document' : 'schematic-one',
					documentType: currentDocumentType,
				};
			},
		},
		dmt_Project: { async getCurrentProjectInfo() { return { uuid: 'project-one' }; } },
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: 'schematic-one' }; } },
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: 'cached-pcb' }; } },
		pcb_PrimitiveComponent: {
			async create() {
				pcbWriteCalls += 1;
				return { primitiveId: 'pcb-created' };
			},
		},
		sch_PrimitiveComponent: {
			async getAllPrimitiveId() {
				idReads += 1;
				if (idReads === 1)
					return ['to-delete'];
				throw new Error('post-delete readback failed');
			},
			async delete() {
				deleteCalls += 1;
				deleteEntered.resolve();
				await finishDelete.promise;
				return true;
			},
			async create() {
				secondWriteCalls += 1;
				return { primitiveId: 'unexpected-write' };
			},
			async getAll() {
				readCalls += 1;
				return [];
			},
		},
	};
	globalThis.ESYS_ToastMessageType = { SUCCESS: 'success' };

	startBridgeRuntime();
	await transportReady.promise;
	const transport = activeTransport;
	const path = '/bridge/jlceda/api/invoke';
	const submit = (requestId, payload) => enqueueTask({ requestId, path, payload, leaseTerm: 1 }, transport);
	let writeAtCompletionRejected = false;
	transport.beforeComplete = (requestId) => {
		if (requestId !== 'uncertain-delete')
			return;
		// This runs before the first result is sent to the Server.
		submit('write-at-result', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		writeAtCompletionRejected = transport.results.has('write-at-result');
	};
	try {
		submit('pcb-write', { apiFullName: 'eda.pcb_PrimitiveComponent.create', args: [] });
		const pcbWrite = await transport.resultFor('pcb-write');
		assert.equal(pcbWrite.error, undefined);
		assert.equal(pcbWriteCalls, 1);
		assert.equal(transport.startedContexts.get('pcb-write').pageKind, 'pcb');
		assert.equal(transport.startedContexts.get('pcb-write').pageUuid, 'cached-pcb');
		currentDocumentType = 1;
		submit('wrong-page-write', { apiFullName: 'eda.pcb_PrimitiveComponent.create', args: [] });
		const wrongPage = await transport.resultFor('wrong-page-write');
		assert.match(wrongPage.error.message, /Current editor is schematic/);
		assert.equal(transport.started.includes('wrong-page-write'), false);
		submit('uncertain-delete', { apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['to-delete'] });
		await deleteEntered.promise;
		// Both following tasks enter taskChain before the first handler returns.
		submit('queued-write', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		submit('queued-read', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] });
		finishDelete.resolve();
		let timeoutId;
		const responses = await Promise.race([
			Promise.all([
				transport.resultFor('uncertain-delete'),
				transport.resultFor('queued-write'),
				transport.resultFor('queued-read'),
				transport.resultFor('write-at-result'),
			]),
			new Promise((_resolve, reject) => {
				timeoutId = setTimeout(() => reject(new Error('Queued task result timed out')), 3000);
			}),
		]).finally(() => clearTimeout(timeoutId));
		const [first, second, read, atCompletion] = responses;
		assert.equal(first.error, undefined);
		assert.equal(first.result.commitUnknown, true);
		assert.equal(transport.startedContexts.get('uncertain-delete').pageKind, 'schematic');
		assert.equal(transport.startedContexts.get('uncertain-delete').pageUuid, 'schematic-one');
		assert.equal(deleteCalls, 1);
		assert.equal(idReads, 2);
		assert.equal(writeAtCompletionRejected, true, 'the barrier must exist before the first result is sent');
		assert.ok(atCompletion.error);
		assert.equal(secondWriteCalls, 0, 'the queued write handler must never run after an unknown commit');
		assert.ok(second.error, 'the queued write must be rejected');
		assert.equal(transport.started.includes('queued-write'), false);
		assert.equal(read.error, undefined, 'a read-only task must remain available');
		assert.equal(readCalls, 1);
		assert.equal(transport.started.includes('queued-read'), true);
		process.stdout.write('Bridge unknown-commit queue barrier test passed\n');
	}
	finally {
		finishDelete.resolve();
		stopBridgeRuntime();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
