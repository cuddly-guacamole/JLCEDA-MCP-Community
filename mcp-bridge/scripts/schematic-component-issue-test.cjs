const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleComponentPlaceAutoTask } = require('../src/mcp/component-place-auto-handler.ts');
const {
	handleComponentPlaceTask,
	handleComponentPlaceStartTask,
	handleComponentPlaceCheckTask,
	handleComponentPlaceCloseTask,
	cleanupAllComponentPlaceSessions,
} = require('../src/mcp/component-place-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { enqueueTask } = require('../src/runtime/bridge-runtime.ts');
const { getPlacementModeWriteRejection } = require('../src/runtime/placement-mode-barrier.ts');

function primitive(id, designator, otherProperty = {}) {
	return {
		getState_PrimitiveId: () => id,
		getState_Designator: () => designator,
		getState_OtherProperty: () => otherProperty,
	};
}

async function main() {
	// EDA 3.x clears BOM metadata if modify omits otherProperty.
	let metadata = { Value: '10k', Datasheet: 'https://example.test/r' };
	let currentPageUuid = 'P1';
	globalThis.eda = {
		sys_Storage: {
			getExtensionUserConfig() { return undefined; },
			async setExtensionUserConfig() {},
		},
		dmt_Schematic: {
			async getCurrentSchematicPageInfo() { return { uuid: currentPageUuid }; },
		},
		sch_PrimitiveComponent: {
			async get(id) { return id === 'r1' ? primitive('r1', 'R1', metadata) : undefined; },
			async modify(id, patch) {
				assert.equal(id, 'r1');
				metadata = patch.otherProperty ?? { Value: '', Datasheet: '' };
				return { designator: patch.designator, otherProperty: metadata };
			},
		},
	};
	const modified = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.modify', args: ['r1', { designator: 'R2' }] });
	assert.deepEqual(modified.result.otherProperty, { Value: '10k', Datasheet: 'https://example.test/r' });
	await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.modify', args: ['r1', { otherProperty: { Value: '22k' } }] });
	assert.deepEqual(metadata, { Value: '22k' });

	// The host's array overload removes only its first element; single IDs work.
	const remaining = new Set(['a', 'b', 'c']);
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...remaining]; },
		async get(id) { return remaining.has(id) ? primitive(id, 'R1') : undefined; },
		async delete(input) {
			const id = Array.isArray(input) ? input[0] : typeof input === 'string' ? input : input.getState_PrimitiveId();
			return remaining.delete(id);
		},
	};
	const deleted = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: [['a', 'b', 'c']] });
	assert.equal(deleted.result, true);
	assert.deepEqual(deleted.deletedIds, ['a', 'b', 'c']);
	assert.deepEqual([...remaining], []);

	// Some host builds reject an ID string but accept its live primitive object.
	remaining.add('d');
	globalThis.eda.sch_PrimitiveComponent.delete = async (input) => {
		if (typeof input === 'string')
			return false;
		return remaining.delete(input.getState_PrimitiveId());
	};
	const objectFallback = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['d'] });
	assert.equal(objectFallback.result, true);
	assert.deepEqual(objectFallback.deletedIds, ['d']);

	// Known IDs on another schematic page must be verified beyond the active page.
	const otherPageIds = new Set(['other-page-component']);
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async (_type, allPages) => allPages ? [...remaining, ...otherPageIds] : [...remaining];
	globalThis.eda.sch_PrimitiveComponent.get = async id => otherPageIds.has(id) ? primitive(id, 'U9') : undefined;
	globalThis.eda.sch_PrimitiveComponent.delete = async input => otherPageIds.delete(typeof input === 'string' ? input : input.getState_PrimitiveId());
	const crossPageDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['other-page-component'] });
	assert.equal(crossPageDelete.result, true);
	assert.deepEqual(crossPageDelete.deletedIds, ['other-page-component']);
	assert.deepEqual([...otherPageIds], []);

	// A successful native deletion with a failed readback must quarantine later writes.
	let postDeleteReads = 0;
	const attemptedDeletes = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() {
			postDeleteReads += 1;
			if (postDeleteReads === 2)
				throw new Error('post-delete ID readback failed');
			return ['uncertain', 'not-attempted'];
		},
		async delete(id) {
			attemptedDeletes.push(id);
			return true;
		},
	};
	const unknownDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: [['uncertain', 'not-attempted']] });
	assert.equal(unknownDelete.ok, false);
	assert.equal(unknownDelete.commitUnknown, true);
	assert.equal(unknownDelete.readbackRequired, true);
	assert.deepEqual(unknownDelete.uncertainIds, ['uncertain']);
	assert.deepEqual(unknownDelete.notAttemptedIds, ['not-attempted']);
	assert.deepEqual(attemptedDeletes, ['uncertain']);

	// The next item's pre-read is still post-write for a batch that already deleted an item.
	let batchReads = 0;
	const batchRemaining = new Set(['done', 'next', 'later']);
	const batchDeletes = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() {
			batchReads += 1;
			if (batchReads === 4)
				throw new Error('next-item ID readback failed');
			return [...batchRemaining];
		},
		async delete(id) {
			batchDeletes.push(id);
			return batchRemaining.delete(id);
		},
	};
	const unknownNextPreRead = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: [['absent', 'done', 'next', 'later']] });
	assert.equal(unknownNextPreRead.commitUnknown, true);
	assert.equal(unknownNextPreRead.readbackRequired, true);
	assert.deepEqual(unknownNextPreRead.deletedIds, ['done']);
	assert.deepEqual(unknownNextPreRead.failedIds, ['absent']);
	assert.deepEqual(unknownNextPreRead.uncertainIds, []);
	assert.deepEqual(unknownNextPreRead.notAttemptedIds, ['next', 'later']);
	assert.deepEqual(batchDeletes, ['done']);

	// The object fallback must carry the same uncertainty when its object read fails.
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return ['fallback-read']; },
		async get() { throw new Error('object readback failed'); },
		async delete() { return false; },
	};
	const unknownFallbackObject = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['fallback-read'] });
	assert.equal(unknownFallbackObject.commitUnknown, true);
	assert.equal(unknownFallbackObject.readbackRequired, true);
	assert.match(unknownFallbackObject.error, /object readback failed/);

	// Also cover the final ID readback after a successful object fallback deletion.
	let fallbackReads = 0;
	const fallbackInputs = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() {
			fallbackReads += 1;
			if (fallbackReads === 3)
				throw new Error('fallback ID readback failed');
			return ['fallback-final'];
		},
		async get(id) { return primitive(id, 'R1'); },
		async delete(input) {
			fallbackInputs.push(input);
			return true;
		},
	};
	const unknownFallbackId = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['fallback-final'] });
	assert.equal(unknownFallbackId.commitUnknown, true);
	assert.equal(unknownFallbackId.readbackRequired, true);
	assert.deepEqual(unknownFallbackId.uncertainIds, ['fallback-final']);
	assert.equal(fallbackInputs.length, 2);

	// A read failure before any delete keeps its original error semantics.
	let preflightDeleteCalls = 0;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { throw new Error('pre-delete ID read failed'); },
		async delete() { preflightDeleteCalls += 1; },
	};
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['preflight'] }), /pre-delete ID read failed/);
	assert.equal(preflightDeleteCalls, 0);

	// One immediate click may happen before placeComponentWithMouse returns.
	const ids = ['existing'];
	globalThis.document = new EventTarget();
	const pressEscape = () => document.dispatchEvent(Object.assign(new Event('keyup'), { key: 'Escape' }));
	const rightClick = () => document.dispatchEvent(Object.assign(new Event('mouseup'), { button: 2 }));
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...ids]; },
		async getAll() { return ids.map(id => primitive(id, id === 'existing' ? 'U4' : 'R1')); },
		async placeComponentWithMouse() {
			ids.push('floating-1');
			return true;
		},
	};
	const descriptor = await handleComponentPlaceTask({ components: [{ uuid: 'device', libraryUuid: 'library' }] });
	assert.equal(Object.hasOwn(descriptor.placement, 'retryCount'), false);
	const start = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	const waitingForExit = await handleComponentPlaceCheckTask({ sessionId: start.sessionId });
	assert.equal(waitingForExit.placed, false);
	assert.equal(waitingForExit.awaitingExit, true);
	assert.deepEqual(waitingForExit.candidatePrimitiveIds, ['floating-1']);
	const concurrentWrite = { apiFullName: 'eda.sch_PrimitiveComponent.modify', args: ['r1', { designator: 'R2' }] };
	assert.match(getPlacementModeWriteRejection('/bridge/jlceda/schematic/connectivity', { action: 'wire_create' }), /正在交互放置/);
	assert.match(getPlacementModeWriteRejection('/bridge/jlceda/component/place/start', { component: { uuid: 'device', libraryUuid: 'library' } }), /正在交互放置/);
	for (const [path, payload] of [
		['/bridge/jlceda/component/place/check', { sessionId: start.sessionId }],
		['/bridge/jlceda/component/place/close', { sessionId: start.sessionId }],
		['/bridge/jlceda/schematic/connectivity', { action: 'wire_preview' }],
		['/bridge/jlceda/context', {}],
	])
		assert.equal(getPlacementModeWriteRejection(path, payload), undefined);
	ids.splice(ids.indexOf('floating-1'), 1);
	ids.push('placed-1');
	pressEscape();
	const check = await handleComponentPlaceCheckTask({ sessionId: start.sessionId });
	assert.equal(check.placed, true);
	assert.deepEqual(check.primitiveIds, ['placed-1']);
	assert.equal(getPlacementModeWriteRejection('/bridge/jlceda/api/invoke', concurrentWrite), undefined);

	globalThis.eda.sch_PrimitiveComponent.placeComponentWithMouse = async () => {
		ids.push('placed-2', 'placed-3');
		return true;
	};
	const duplicateStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	const duplicateWaiting = await handleComponentPlaceCheckTask({ sessionId: duplicateStart.sessionId });
	assert.equal(duplicateWaiting.awaitingExit, true);
	assert.deepEqual(duplicateWaiting.candidatePrimitiveIds, ['placed-2', 'placed-3']);
	rightClick();
	const duplicateCheck = await handleComponentPlaceCheckTask({ sessionId: duplicateStart.sessionId });
	assert.equal(duplicateCheck.placed, false);
	assert.equal(duplicateCheck.duplicate, true);
	assert.deepEqual(duplicateCheck.primitiveIds, ['placed-2', 'placed-3']);

	// Escape can arrive before the mouse-placement API resolves.
	globalThis.eda.sch_PrimitiveComponent.placeComponentWithMouse = async () => {
		ids.push('placed-4');
		pressEscape();
		return true;
	};
	const earlyExitStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	const earlyExitCheck = await handleComponentPlaceCheckTask({ sessionId: earlyExitStart.sessionId });
	assert.equal(earlyExitCheck.placed, true);
	assert.deepEqual(earlyExitCheck.primitiveIds, ['placed-4']);
	globalThis.eda.sch_PrimitiveComponent.placeComponentWithMouse = async () => {
		ids.push('floating-cancel');
		return true;
	};
	const cancelledStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	const cancelledWaiting = await handleComponentPlaceCheckTask({ sessionId: cancelledStart.sessionId });
	assert.deepEqual(cancelledWaiting.candidatePrimitiveIds, ['floating-cancel']);
	ids.splice(ids.indexOf('floating-cancel'), 1);
	pressEscape();
	const cancelledCheck = await handleComponentPlaceCheckTask({ sessionId: cancelledStart.sessionId });
	assert.equal(cancelledCheck.userCancelled, true);
	assert.equal(cancelledCheck.placed, false);

	// Switching to another open page must not count its existing symbol as a new placement.
	const getPageOneIds = globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId;
	const getPageOneComponents = globalThis.eda.sch_PrimitiveComponent.getAll;
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async () => currentPageUuid === 'P1' ? getPageOneIds() : ['other-page-existing'];
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => currentPageUuid === 'P1' ? getPageOneComponents() : [primitive('other-page-existing', 'U99')];
	globalThis.eda.sch_PrimitiveComponent.placeComponentWithMouse = async () => true;
	const pageBoundStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	assert.equal(pageBoundStart.ok, true);
	currentPageUuid = 'P2';
	pressEscape();
	const wrongPageCheck = await handleComponentPlaceCheckTask({ sessionId: pageBoundStart.sessionId });
	assert.equal(wrongPageCheck.ok, false);
	assert.match(wrongPageCheck.error, /图页已切换/);
	await handleComponentPlaceCloseTask({ sessionId: pageBoundStart.sessionId });
	currentPageUuid = 'P1';
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = getPageOneIds;
	globalThis.eda.sch_PrimitiveComponent.getAll = getPageOneComponents;

	// A lost connection must retire the old session and block a new placement
	// until the user exits the native EDA placement mode.
	let mousePlaceCalls = 0;
	globalThis.eda.sch_PrimitiveComponent.placeComponentWithMouse = async () => {
		mousePlaceCalls += 1;
		return true;
	};
	const lostStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	assert.equal(lostStart.ok, true);
	const taskResults = [];
	const mockTransport = {
		completeTask(requestId, _leaseTerm, _result, error) { taskResults.push({ requestId, error }); },
	};
	const apiWrite = { apiFullName: 'eda.sch_PrimitiveComponent.modify', args: ['r1', { designator: 'R2' }] };
	enqueueTask({ requestId: 'write-before-loss', path: '/bridge/jlceda/api/invoke', payload: apiWrite, leaseTerm: 0 }, mockTransport);
	assert.match(taskResults.find(item => item.requestId === 'write-before-loss').error.message, /正在交互放置/);
	await cleanupAllComponentPlaceSessions();
	enqueueTask({ requestId: 'after-loss', path: '/bridge/jlceda/api/invoke', payload: apiWrite, leaseTerm: 0 }, mockTransport);
	assert.match(taskResults.find(item => item.requestId === 'after-loss').error.message, /Esc|右键/);
	enqueueTask({ requestId: 'read-after-loss', path: '/bridge/jlceda/schematic/connectivity', payload: { action: 'wire_preview' }, leaseTerm: 0 }, mockTransport);
	await new Promise(resolve => setImmediate(resolve));
	assert.match(taskResults.find(item => item.requestId === 'read-after-loss').error.message, /待命状态/);
	const lostCheck = await handleComponentPlaceCheckTask({ sessionId: lostStart.sessionId });
	assert.equal(lostCheck.ok, false);
	const blockedWrites = [
		['/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.modify', args: ['r1', { designator: 'R2' }] }],
		['/bridge/jlceda/schematic/connectivity', { action: 'wire_create' }],
		['/bridge/jlceda/component/place-auto', { components: [] }],
		['/bridge/jlceda/component/place/start', { component: { uuid: 'device', libraryUuid: 'library' } }],
	];
	for (const [path, payload] of blockedWrites)
		assert.match(getPlacementModeWriteRejection(path, payload), /Esc|右键/);
	const allowedReads = [
		['/bridge/jlceda/context', {}],
		['/bridge/jlceda/schematic/read', {}],
		['/bridge/jlceda/schematic/connectivity', { action: 'wire_preview' }],
		['/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] }],
		['/bridge/jlceda/component/place/check', { sessionId: lostStart.sessionId }],
	];
	for (const [path, payload] of allowedReads)
		assert.equal(getPlacementModeWriteRejection(path, payload), undefined);
	const blockedAfterLoss = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	assert.equal(blockedAfterLoss.ok, false);
	assert.match(blockedAfterLoss.error, /Esc|右键/);
	assert.equal(mousePlaceCalls, 1);
	rightClick();
	for (const [path, payload] of blockedWrites)
		assert.equal(getPlacementModeWriteRejection(path, payload), undefined);
	enqueueTask({ requestId: 'after-exit', path: '/bridge/jlceda/api/invoke', payload: apiWrite, leaseTerm: 0 }, mockTransport);
	await new Promise(resolve => setImmediate(resolve));
	assert.match(taskResults.find(item => item.requestId === 'after-exit').error.message, /待命状态/);
	const resumed = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	assert.equal(resumed.ok, true);
	assert.equal(mousePlaceCalls, 2);
	pressEscape();
	assert.equal((await handleComponentPlaceCheckTask({ sessionId: resumed.sessionId })).userCancelled, true);

	// A normal close before Esc (for example, after timeout) needs the same guard.
	const closedBeforeExit = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	await handleComponentPlaceCloseTask({ sessionId: closedBeforeExit.sessionId });
	assert.match(getPlacementModeWriteRejection(blockedWrites[0][0], blockedWrites[0][1]), /Esc|右键/);
	assert.equal((await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } })).ok, false);
	assert.equal(mousePlaceCalls, 3);
	pressEscape();

	// A disconnect during baseline read must prevent its pending start from
	// entering mouse placement even though no session existed at disconnect.
	let releaseBaseline;
	let baselineStarted;
	const baselineEntered = new Promise((resolve) => {
		baselineStarted = resolve;
	});
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = () => new Promise((resolve) => {
		releaseBaseline = () => resolve([...ids]);
		baselineStarted();
	});
	const pendingStart = handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	await baselineEntered;
	await cleanupAllComponentPlaceSessions();
	releaseBaseline();
	assert.equal((await pendingStart).ok, false);
	assert.equal(mousePlaceCalls, 3);

	// A host annotation pass may rename existing symbols during coordinate placement.
	let existingDesignator = 'U4';
	let createCalls = 0;
	const components = [primitive('existing-u', existingDesignator)];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return components; },
		async create() {
			createCalls += 1;
			existingDesignator = 'U15';
			components[0] = primitive('existing-u', existingDesignator);
			const created = primitive('new-r', 'R1');
			components.push(created);
			return created;
		},
	};
	const placed = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'device', libraryUuid: 'library', x: 100, y: 200 },
		{ uuid: 'next-device', libraryUuid: 'library', x: 200, y: 200 },
	] });
	assert.equal(placed.ok, false);
	assert.equal(placed.needsReview, true);
	assert.equal(placed.placedCount, 1);
	assert.equal(placed.notAttemptedCount, 1);
	assert.equal(createCalls, 1);
	assert.equal(placed.placedComponents[0].primitiveId, 'new-r');
	assert.deepEqual(placed.designatorChanges, [{ primitiveId: 'existing-u', before: 'U4', after: 'U15' }]);
	assert.match(placed.annotationWarning, /位号/);

	// A later create can renumber an earlier component from the same request.
	// Stop before the third placement and return the first component's current designator.
	let batchCreateCalls = 0;
	const batchComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return batchComponents; },
		async create() {
			batchCreateCalls += 1;
			if (batchCreateCalls === 1) {
				const first = primitive('batch-first', 'R1');
				batchComponents.push(first);
				return first;
			}
			batchComponents[1] = primitive('batch-first', 'R9');
			const second = primitive('batch-second', 'R2');
			batchComponents.push(second);
			return second;
		},
	};
	const batchPlaced = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
		{ uuid: 'third', libraryUuid: 'library' },
	] });
	assert.equal(batchPlaced.ok, false);
	assert.equal(batchPlaced.needsReview, true);
	assert.equal(batchPlaced.placedCount, 2);
	assert.equal(batchPlaced.notAttemptedCount, 1);
	assert.equal(batchCreateCalls, 2);
	assert.equal(batchPlaced.placedComponents[0].designator, 'R9');
	assert.equal(batchPlaced.placedComponents[1].designator, 'R2');
	assert.deepEqual(batchPlaced.designatorChanges, [{ primitiveId: 'batch-first', before: 'R1', after: 'R9' }]);
	assert.match(batchPlaced.annotationWarning, /本批次/);

	globalThis.eda.sch_PrimitiveComponent.getAll = async () => {
		throw new Error('readback failed');
	};
	const preflightFailure = await handleComponentPlaceAutoTask({ components: [{ uuid: 'not-placed', libraryUuid: 'library' }] });
	assert.equal(preflightFailure.ok, false);
	assert.equal(preflightFailure.notAttemptedCount, 1);
	assert.equal(createCalls, 1);

	let readCount = 0;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() {
			readCount += 1;
			if (readCount > 1)
				throw new Error('post-placement readback failed');
			return [primitive('existing-u', 'U4')];
		},
		async create() { return primitive('placed-before-readback-error', 'R1'); },
	};
	const uncertainPlacement = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
	] });
	assert.equal(uncertainPlacement.ok, false);
	assert.equal(uncertainPlacement.needsReview, true);
	assert.equal(uncertainPlacement.placedCount, 1);
	assert.equal(uncertainPlacement.notAttemptedCount, 1);
	assert.equal(uncertainPlacement.placedComponents[0].primitiveId, 'placed-before-readback-error');
}

main().then(() => console.log('schematic component issue tests passed')).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
