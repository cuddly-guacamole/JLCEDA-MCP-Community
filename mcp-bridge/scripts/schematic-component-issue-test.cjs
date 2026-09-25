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
		getState_ComponentType: () => 'part',
		getState_Designator: () => designator,
		getState_OtherProperty: () => otherProperty,
	};
}

function placedPrimitive(id, x = 510, y = 415) {
	return {
		...primitive(id, 'U?'),
		getState_Component: () => ({ libraryUuid: 'library', uuid: 'device' }),
		getState_SubPartName: () => undefined,
		getState_X: () => x,
		getState_Y: () => y,
		getState_Rotation: () => 0,
		getState_Mirror: () => false,
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
	let unsafeModifyCalls = 0;
	for (const component of [
		{ otherProperty: { Value: 'stale' } },
		{ getState_OtherProperty() { throw new Error('state read failed'); } },
		{ getState_OtherProperty() { return undefined; } },
	]) {
		globalThis.eda.sch_PrimitiveComponent = {
			async get() { return component; },
			async modify() { unsafeModifyCalls += 1; },
		};
		await assert.rejects(
			handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.modify', args: ['r1', { designator: 'R2' }] }),
			/无法读取器件原有 BOM 属性/,
		);
	}
	assert.equal(unsafeModifyCalls, 0, 'unreadable BOM metadata must block native modify');
	const explicitProperty = await handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.modify',
		args: ['r1', { otherProperty: { Value: '22k' } }],
	});
	assert.equal(explicitProperty.result, undefined);
	assert.equal(unsafeModifyCalls, 1, 'explicit replacement metadata needs no state getter');

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
	const allSchematicPages = Array.from({ length: 135 }, (_, index) => ({
		uuid: `page-${index}`,
		parentSchematicUuid: 'target-schematic',
		name: `Page ${index}`,
	}));
	globalThis.eda.dmt_Schematic.getAllSchematicPagesInfo = async () => allSchematicPages;
	const pageInventory = await handleApiInvokeTask({ apiFullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo', args: [] });
	assert.equal(pageInventory.result.length, 120, 'ordinary API results retain their bounded form');
	assert.equal(pageInventory.schematicPages.length, allSchematicPages.length, 'recovery inventory must include every page');
	assert.equal(pageInventory.pageCount, allSchematicPages.length);
	assert.equal(pageInventory.schematicPages[134].uuid, 'page-134');

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
	const originalPlacementApi = globalThis.eda.sch_PrimitiveComponent;
	const interactiveIds = ['existing-u'];
	const interactiveBom = { Value: 'FM25V20A', Datasheet: 'https://example.test/f' };
	let interactiveDesignator = 'U5';
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...interactiveIds]; },
		async getAll() {
			return interactiveIds.map(id => id === 'existing-u'
				? primitive(id, interactiveDesignator, interactiveBom) : placedPrimitive(id));
		},
		async placeComponentWithMouse() {
			interactiveDesignator = 'U16';
			interactiveIds.push('new-interactive');
			return true;
		},
		async modify(id, patch) {
			assert.equal(id, 'existing-u');
			assert.deepEqual(patch.otherProperty, interactiveBom);
			interactiveDesignator = patch.designator;
			return primitive(id, interactiveDesignator, patch.otherProperty);
		},
	};
	const restoredStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const restoredCheck = await handleComponentPlaceCheckTask({ sessionId: restoredStart.sessionId });
	assert.equal(restoredCheck.placed, true);
	assert.deepEqual(restoredCheck.designatorChanges, []);
	assert.deepEqual(restoredCheck.restoredDesignators, [{ primitiveId: 'existing-u', before: 'U16', after: 'U5' }]);
	assert.equal(restoredCheck.annotationWarning, undefined);
	assert.deepEqual(interactiveBom, { Value: 'FM25V20A', Datasheet: 'https://example.test/f' });
	interactiveIds.length = 1;
	interactiveDesignator = 'U5';
	globalThis.eda.sch_PrimitiveComponent.modify = async () => { throw new Error('RPC Call modify Timed Out'); };
	const uncertainDesignatorStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const uncertainDesignatorCheck = await handleComponentPlaceCheckTask({ sessionId: uncertainDesignatorStart.sessionId });
	assert.equal(uncertainDesignatorCheck.ok, false);
	assert.equal(uncertainDesignatorCheck.commitUnknown, true);
	assert.equal(uncertainDesignatorCheck.nativeCallSettled, false);
	assert.deepEqual(uncertainDesignatorCheck.primitiveIds, ['new-interactive']);
	assert.match(uncertainDesignatorCheck.error, /Timed Out/);
	globalThis.eda.sch_PrimitiveComponent = originalPlacementApi;

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

	// A single click can create two identical EDA primitives. Delete only the
	// extra ID and confirm that the retained primitive is the only new one.
	const initialPlacementApi = globalThis.eda.sch_PrimitiveComponent;
	const exactIds = ['existing'];
	const deletedExactIds = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...exactIds]; },
		async getAll() { return exactIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(id) {
			deletedExactIds.push(id);
			exactIds.splice(exactIds.indexOf(id), 1);
			return true;
		},
		async placeComponentWithMouse() {
			exactIds.push('same-1', 'same-2');
			return true;
		},
	};
	const exactStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const exactCheck = await handleComponentPlaceCheckTask({ sessionId: exactStart.sessionId });
	assert.equal(exactCheck.placed, true);
	assert.equal(exactCheck.duplicate, false);
	assert.deepEqual(exactCheck.primitiveIds, ['same-1']);
	assert.deepEqual(exactCheck.removedDuplicateIds, ['same-2']);
	assert.deepEqual(deletedExactIds, ['same-2']);
	assert.deepEqual(exactIds, ['existing', 'same-1']);
	assert.equal(exactCheck.annotationWarning, undefined, 'ordinary single-part symbols can have no sub-part name');

	// An explicitly selected sub-part must still match the placed primitives.
	const namedIds = ['existing'];
	const deletedNamedIds = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...namedIds]; },
		async getAll() { return namedIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(id) {
			deletedNamedIds.push(id);
			return true;
		},
		async placeComponentWithMouse() {
			namedIds.push('named-1', 'named-2');
			return true;
		},
	};
	const namedStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library', subPartName: 'B' } });
	pressEscape();
	const namedCheck = await handleComponentPlaceCheckTask({ sessionId: namedStart.sessionId });
	assert.equal(namedCheck.placed, false);
	assert.equal(namedCheck.duplicate, true);
	assert.deepEqual(deletedNamedIds, []);

	// Two intentional placements at different positions must be preserved.
	const distinctIds = ['existing'];
	const deletedDistinctIds = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...distinctIds]; },
		async getAll() {
			return distinctIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id, id === 'distinct-1' ? 510 : 610));
		},
		async delete(id) {
			deletedDistinctIds.push(id);
			return true;
		},
		async placeComponentWithMouse() {
			distinctIds.push('distinct-1', 'distinct-2');
			return true;
		},
	};
	const distinctStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const distinctCheck = await handleComponentPlaceCheckTask({ sessionId: distinctStart.sessionId });
	assert.equal(distinctCheck.placed, false);
	assert.equal(distinctCheck.duplicate, true);
	assert.deepEqual(deletedDistinctIds, []);
	assert.deepEqual(distinctIds, ['existing', 'distinct-1', 'distinct-2']);

	// A failed post-delete readback must report the mutation as uncertain.
	const uncertainIds = ['existing'];
	let uncertainIdReads = 0;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() {
			uncertainIdReads += 1;
			if (uncertainIdReads > 2)
				throw new Error('duplicate readback failed');
			return [...uncertainIds];
		},
		async getAll() { return uncertainIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(id) {
			uncertainIds.splice(uncertainIds.indexOf(id), 1);
			return true;
		},
		async placeComponentWithMouse() {
			uncertainIds.push('uncertain-1', 'uncertain-2');
			return true;
		},
	};
	const uncertainStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const uncertainCheck = await handleComponentPlaceCheckTask({ sessionId: uncertainStart.sessionId });
	assert.equal(uncertainCheck.ok, false);
	assert.equal(uncertainCheck.commitUnknown, true);
	assert.equal(uncertainCheck.readbackRequired, true);
	assert.equal(uncertainCheck.nativeCallSettled, true);
	assert.match(uncertainCheck.error, /duplicate readback failed/);
	assert.equal((await handleComponentPlaceCheckTask({ sessionId: uncertainStart.sessionId })).ok, false);

	// An EDA delete timeout can commit after an immediate readback.
	const timeoutIds = ['existing'];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...timeoutIds]; },
		async getAll() { return timeoutIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(id) {
			timeoutIds.splice(timeoutIds.indexOf(id), 1);
			throw new Error('RPC Call delete Timed Out');
		},
		async placeComponentWithMouse() {
			timeoutIds.push('timeout-1', 'timeout-2');
			return true;
		},
	};
	const timeoutStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const timeoutCheck = await handleComponentPlaceCheckTask({ sessionId: timeoutStart.sessionId });
	assert.equal(timeoutCheck.ok, false);
	assert.equal(timeoutCheck.commitUnknown, true);
	assert.equal(timeoutCheck.nativeCallSettled, false);
	assert.match(timeoutCheck.error, /Timed Out/);
	globalThis.eda.sch_PrimitiveComponent = initialPlacementApi;

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

	// Restore existing designators after a host annotation pass without losing BOM fields.
	let existingDesignator = 'U4';
	let createCalls = 0;
	const existingBom = { Value: 'STM32', Manufacturer: 'ST' };
	const components = [primitive('existing-u', existingDesignator, existingBom)];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return components; },
		async create() {
			createCalls += 1;
			if (createCalls === 1) {
				existingDesignator = 'U15';
				components[0] = primitive('existing-u', existingDesignator, existingBom);
			}
			const created = primitive(`new-r-${createCalls}`, `R${createCalls}`);
			components.push(created);
			return created;
		},
		async modify(id, patch) {
			assert.equal(id, 'existing-u');
			assert.equal(patch.designator, 'U4');
			assert.deepEqual(patch.otherProperty, existingBom);
			existingDesignator = patch.designator;
			components[0] = primitive(id, existingDesignator, patch.otherProperty);
			return components[0];
		},
	};
	const placed = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'device', libraryUuid: 'library', x: 100, y: 200 },
		{ uuid: 'next-device', libraryUuid: 'library', x: 200, y: 200 },
	] });
	assert.equal(placed.ok, true);
	assert.equal(placed.placedCount, 2);
	assert.equal(createCalls, 2);
	assert.equal(placed.placedComponents[0].primitiveId, 'new-r-1');
	assert.deepEqual(placed.designatorChanges, []);
	assert.deepEqual(placed.restoredDesignators, [{ primitiveId: 'existing-u', before: 'U15', after: 'U4' }]);
	assert.deepEqual(components[0].getState_OtherProperty(), existingBom);
	const blankedComponents = [primitive('existing-u', 'U4', existingBom)];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return blankedComponents; },
		async create() {
			blankedComponents[0] = primitive('existing-u', '', existingBom);
			const created = primitive('new-r', 'R1');
			blankedComponents.push(created);
			return created;
		},
		async modify(id, patch) {
			blankedComponents[0] = primitive(id, patch.designator, patch.otherProperty);
			return blankedComponents[0];
		},
	};
	const restoredBlank = await handleComponentPlaceAutoTask({ components: [{ uuid: 'new-r', libraryUuid: 'library' }] });
	assert.equal(restoredBlank.ok, true);
	assert.deepEqual(restoredBlank.restoredDesignators, [{ primitiveId: 'existing-u', before: '', after: 'U4' }]);
	const noCustomProperty = (id, designator) => ({
		...primitive(id, designator),
		getState_OtherProperty: () => undefined,
	});
	const noCustomComponents = [noCustomProperty('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return noCustomComponents; },
		async create() {
			noCustomComponents[0] = noCustomProperty('existing-u', 'U15');
			const created = primitive('new-r', 'R1');
			noCustomComponents.push(created);
			return created;
		},
		async modify(id, patch) {
			assert.deepEqual(patch.otherProperty, {});
			noCustomComponents[0] = noCustomProperty(id, patch.designator);
			return noCustomComponents[0];
		},
	};
	const restoredNoCustom = await handleComponentPlaceAutoTask({ components: [{ uuid: 'new-r', libraryUuid: 'library' }] });
	assert.equal(restoredNoCustom.ok, true);
	assert.deepEqual(restoredNoCustom.restoredDesignators, [{ primitiveId: 'existing-u', before: 'U15', after: 'U4' }]);

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
	assert.match(batchPlaced.annotationWarning, /位号/);
	let recoveredBatchCalls = 0;
	const recoveredBatchComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return recoveredBatchComponents; },
		async create() {
			recoveredBatchCalls += 1;
			if (recoveredBatchCalls === 2)
				recoveredBatchComponents[1] = primitive('first-batch', 'R9', { Value: '10k' });
			const created = primitive(
				recoveredBatchCalls === 1 ? 'first-batch' : `${recoveredBatchCalls}-batch`,
				`R${recoveredBatchCalls}`,
				recoveredBatchCalls === 1 ? { Value: '10k' } : {},
			);
			recoveredBatchComponents.push(created);
			return created;
		},
		async modify(id, patch) {
			assert.equal(id, 'first-batch');
			assert.deepEqual(patch.otherProperty, { Value: '10k' });
			recoveredBatchComponents[1] = primitive(id, patch.designator, patch.otherProperty);
			return recoveredBatchComponents[1];
		},
	};
	const recoveredBatch = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
		{ uuid: 'third', libraryUuid: 'library' },
	] });
	assert.equal(recoveredBatch.ok, true);
	assert.equal(recoveredBatchCalls, 3);
	assert.deepEqual(recoveredBatch.designatorChanges, []);
	assert.deepEqual(recoveredBatch.restoredDesignators, [{ primitiveId: 'first-batch', before: 'R9', after: 'R1' }]);
	assert.equal(recoveredBatch.placedComponents[0].designator, 'R1');

	let collisionModifyCalls = 0;
	const collisionComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return collisionComponents; },
		async create() {
			collisionComponents[0] = primitive('existing-u', 'U15');
			const created = primitive('new-u', 'U4');
			collisionComponents.push(created);
			return created;
		},
		async modify() { collisionModifyCalls += 1; },
	};
	const collision = await handleComponentPlaceAutoTask({ components: [{ uuid: 'new-u', libraryUuid: 'library' }] });
	assert.equal(collision.ok, false);
	assert.equal(collisionModifyCalls, 0);
	assert.equal(collision.commitUnknown, undefined);
	assert.deepEqual(collision.designatorChanges, [{ primitiveId: 'existing-u', before: 'U4', after: 'U15' }]);
	assert.match(collision.annotationWarning, /占用/);

	const failedModifyComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return failedModifyComponents; },
		async create() {
			failedModifyComponents[0] = primitive('existing-u', 'U15');
			const created = primitive('new-r', 'R1');
			failedModifyComponents.push(created);
			return created;
		},
		async modify() { throw new Error('RPC Call modify Timed Out'); },
	};
	const uncertainRestore = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' }, { uuid: 'second', libraryUuid: 'library' },
	] });
	assert.equal(uncertainRestore.ok, false);
	assert.equal(uncertainRestore.placedCount, 1);
	assert.equal(uncertainRestore.notAttemptedCount, 1);
	assert.equal(uncertainRestore.commitUnknown, true);
	assert.equal(uncertainRestore.readbackRequired, true);
	assert.equal(uncertainRestore.nativeCallSettled, false);
	assert.match(uncertainRestore.annotationWarning, /Timed Out/);

	let restoreReads = 0;
	const settledComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() {
			restoreReads += 1;
			if (restoreReads === 3)
				throw new Error('restore readback failed');
			return settledComponents;
		},
		async create() {
			settledComponents[0] = primitive('existing-u', 'U15');
			const created = primitive('new-r', 'R1');
			settledComponents.push(created);
			return created;
		},
		async modify(_id, patch) {
			settledComponents[0] = primitive('existing-u', patch.designator, patch.otherProperty);
			return settledComponents[0];
		},
	};
	const uncertainReadback = await handleComponentPlaceAutoTask({ components: [{ uuid: 'first', libraryUuid: 'library' }] });
	assert.equal(uncertainReadback.ok, false);
	assert.equal(uncertainReadback.commitUnknown, true);
	assert.equal(uncertainReadback.nativeCallSettled, true);
	assert.match(uncertainReadback.annotationWarning, /readback failed/);

	globalThis.eda.sch_PrimitiveComponent.getAll = async () => {
		throw new Error('readback failed');
	};
	const preflightFailure = await handleComponentPlaceAutoTask({ components: [{ uuid: 'not-placed', libraryUuid: 'library' }] });
	assert.equal(preflightFailure.ok, false);
	assert.equal(preflightFailure.notAttemptedCount, 1);
	assert.equal(createCalls, 2);

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
