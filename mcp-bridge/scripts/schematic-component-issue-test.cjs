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
		dmt_SelectControl: {
			async getCurrentDocumentInfo() { return { uuid: currentPageUuid }; },
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
		{ getState_OtherProperty() { return null; } },
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
	globalThis.eda.sch_PrimitiveComponent = {
		async get() {
			return {
				getState_OtherProperty() {
					return undefined;
				},
			};
		},
		async modify(_id, patch) {
			assert.deepEqual(patch.otherProperty, unsafeModifyCalls === 0 ? {} : { Value: '22k' });
			unsafeModifyCalls += 1;
			return patch;
		},
	};
	const noCustomProperties = await handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.modify',
		args: ['r1', { designator: 'R2' }],
	});
	assert.deepEqual(noCustomProperties.result.otherProperty, {});
	globalThis.eda.sch_PrimitiveComponent.get = async () => {
		throw new Error('explicit property must skip original-state read');
	};
	const explicitProperty = await handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.modify',
		args: ['r1', { otherProperty: { Value: '22k' } }],
	});
	assert.deepEqual(explicitProperty.result.otherProperty, { Value: '22k' });
	assert.equal(unsafeModifyCalls, 2, 'explicit replacement metadata needs no state getter');
	globalThis.eda.sch_PrimitiveComponent = {
		async modify() { throw new Error('RPC Call modify Timed Out'); },
		async getAll() { throw new Error('RPC Call getAll Timed Out'); },
	};
	const uncertainInvoke = await handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.modify',
		args: ['r1', { otherProperty: {} }],
	});
	assert.equal(uncertainInvoke.commitUnknown, true);
	assert.equal(uncertainInvoke.readbackRequired, true);
	assert.equal(uncertainInvoke.nativeCallSettled, false);
	await assert.rejects(
		handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] }),
		/Timed Out/,
		'read-only API failures must remain ordinary errors',
	);

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
	await assert.rejects(
		handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: [[{ primitiveId: 'a' }]] }),
		/只接受单个 ID 或 ID 数组/,
	);
	const initialDeleteApi = globalThis.eda.sch_PrimitiveComponent;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return ['timeout-id']; },
		async delete() { throw new Error('RPC Call delete Timed Out'); },
	};
	const uncertainDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['timeout-id'] });
	assert.equal(uncertainDelete.commitUnknown, true);
	assert.equal(uncertainDelete.nativeCallSettled, false);
	assert.deepEqual(uncertainDelete.uncertainIds, ['timeout-id']);
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return ['fallback-timeout']; },
		async getAll() { return [primitive('fallback-timeout', 'R1')]; },
		async delete(input) {
			if (typeof input === 'string')
				return false;
			throw new Error('RPC Call delete Timed Out');
		},
	};
	const uncertainFallbackDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['fallback-timeout'] });
	assert.equal(uncertainFallbackDelete.commitUnknown, true);
	assert.equal(uncertainFallbackDelete.nativeCallSettled, false);
	assert.deepEqual(uncertainFallbackDelete.uncertainIds, ['fallback-timeout']);
	globalThis.eda.sch_PrimitiveComponent = initialDeleteApi;

	// Some host builds reject an ID string but accept its live primitive object.
	remaining.add('d');
	globalThis.eda.sch_PrimitiveComponent.delete = async (input) => {
		if (typeof input === 'string')
			return false;
		return remaining.delete(input.getState_PrimitiveId());
	};
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [...remaining].map(id => primitive(id, 'R1'));
	const objectFallback = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['d'] });
	assert.equal(objectFallback.result, true);
	assert.deepEqual(objectFallback.deletedIds, ['d']);

	// A copied page can share primitive IDs with its source. Only the active page is deleted and verified.
	const sourcePageIds = new Set(['shared-1', 'shared-2', 'other-page-component']);
	const copiedPageIds = new Set(['shared-1', 'shared-2']);
	let copiedPageIdReads = 0;
	currentPageUuid = 'P2';
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async (_type, allPages) => {
		copiedPageIdReads += 1;
		return allPages ? [...sourcePageIds, ...copiedPageIds] : [...copiedPageIds];
	};
	globalThis.eda.sch_PrimitiveComponent.delete = async input => copiedPageIds.delete(typeof input === 'string' ? input : input.getState_PrimitiveId());
	const copiedPageDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: [['shared-1', 'shared-2']] });
	assert.equal(copiedPageDelete.result, true);
	assert.equal(copiedPageDelete.pageUuid, 'P2');
	assert.deepEqual(copiedPageDelete.deletedIds, ['shared-1', 'shared-2']);
	assert.equal(copiedPageIdReads, 3, 'batch delete needs one initial list and one readback per ID');
	assert.deepEqual([...sourcePageIds], ['shared-1', 'shared-2', 'other-page-component'], 'source page remains intact');
	assert.equal(copiedPageIds.size, 0);
	let crossPageNativeCalls = 0;
	const otherPageIds = new Set(['other-page-component']);
	globalThis.eda.sch_PrimitiveComponent.delete = async () => {
		crossPageNativeCalls += 1;
		return false;
	};
	await assert.rejects(
		handleApiInvokeTask({ apiFullName: 'x.sch_PrimitiveComponent.delete', args: ['other-page-component'] }),
		/apiFullName 格式非法/,
	);
	assert.equal(crossPageNativeCalls, 0, 'a non-eda prefix must not bypass page-bound deletion');
	const crossPageDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['other-page-component'] });
	assert.equal(crossPageDelete.result, false);
	assert.deepEqual(crossPageDelete.failedIds, ['other-page-component']);
	assert.deepEqual([...otherPageIds], ['other-page-component']);
	assert.equal(crossPageNativeCalls, 0, 'other-page ID must not reach the native delete API');
	currentPageUuid = 'P1';
	const originalDocumentInfo = globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'another-page' });
	await assert.rejects(
		handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['shared-1'] }),
		/尚未同步/,
	);
	assert.equal(crossPageNativeCalls, 0);
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = originalDocumentInfo;
	let switchedPageDeleteCalls = 0;
	const switchedPageIds = new Set(['first', 'second']);
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId(_type, allPages) {
			assert.equal(allPages, false);
			return [...switchedPageIds];
		},
		async delete(id) {
			switchedPageDeleteCalls += 1;
			switchedPageIds.delete(id);
			currentPageUuid = 'P3';
			return true;
		},
	};
	const switchedPageDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: [['first', 'second']] });
	assert.equal(switchedPageDelete.commitUnknown, true);
	assert.deepEqual(switchedPageDelete.uncertainIds, ['first']);
	assert.deepEqual(switchedPageDelete.notAttemptedIds, ['second']);
	assert.equal(switchedPageDeleteCalls, 1, 'page switch must stop the batch');
	currentPageUuid = 'P1';

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

	// The previous item's verified current-page read is reused as the next pre-read.
	// A failed read after the second deletion reports that item as uncertain.
	let batchReads = 0;
	const batchRemaining = new Set(['done', 'next', 'later']);
	const batchDeletes = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() {
			batchReads += 1;
			if (batchReads === 3)
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
	assert.deepEqual(unknownNextPreRead.uncertainIds, ['next']);
	assert.deepEqual(unknownNextPreRead.notAttemptedIds, ['later']);
	assert.deepEqual(batchDeletes, ['done', 'next']);

	// The object fallback must carry the same uncertainty when its object read fails.
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return ['fallback-read']; },
		async getAll() { throw new Error('object readback failed'); },
		async delete() { return false; },
	};
	const unknownFallbackObject = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['fallback-read'] });
	assert.equal(unknownFallbackObject.commitUnknown, true);
	assert.equal(unknownFallbackObject.readbackRequired, true);
	assert.match(unknownFallbackObject.error, /object readback failed/);
	let staleObjectPresent = true;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return ['stale-id']; },
		async getAll() { return staleObjectPresent ? [primitive('stale-id', 'R1')] : []; },
		async delete() {
			staleObjectPresent = false;
			return false;
		},
	};
	const staleIdAfterDelete = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['stale-id'] });
	assert.equal(staleIdAfterDelete.commitUnknown, true, 'stale ID and object lists cannot prove deletion failed');
	assert.deepEqual(staleIdAfterDelete.uncertainIds, ['stale-id']);
	assert.match(staleIdAfterDelete.error, /对象与图元 ID 列表不一致/);

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
		async getAll() { return [primitive('fallback-final', 'R1')]; },
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

	// EDA can expose a committed symbol through getAll while its ID-only API
	// still returns the pre-placement list. The object baseline must also cover
	// existing symbols omitted by the ID-only API, including empty designators.
	const delayedIds = ['known-existing'];
	const delayedComponents = [primitive('known-existing', 'U4'), primitive('object-only-existing', '')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId(componentType, allPages) {
			assert.equal(componentType, null);
			assert.equal(allPages, false);
			return [...delayedIds];
		},
		async getAll(componentType, allPages) {
			assert.equal(componentType, null);
			assert.equal(allPages, false);
			return [...delayedComponents];
		},
		async placeComponentWithMouse() {
			delayedComponents.push(placedPrimitive('committed-before-id-index'));
			return true;
		},
	};
	const delayedStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	assert.equal(delayedStart.ok, true);
	const delayedWaiting = await handleComponentPlaceCheckTask({ sessionId: delayedStart.sessionId });
	assert.equal(delayedWaiting.awaitingExit, true);
	assert.deepEqual(delayedWaiting.candidatePrimitiveIds, ['committed-before-id-index']);
	pressEscape();
	const delayedCheck = await handleComponentPlaceCheckTask({ sessionId: delayedStart.sessionId });
	assert.equal(delayedCheck.placed, true);
	assert.deepEqual(delayedCheck.primitiveIds, ['committed-before-id-index']);
	assert.equal(delayedCheck.userCancelled, false);

	// An object visible during mouse preview must not be called placed when
	// it disappears before Escape.
	delayedComponents.pop();
	const delayedCancelStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	assert.equal((await handleComponentPlaceCheckTask({ sessionId: delayedCancelStart.sessionId })).awaitingExit, true);
	delayedComponents.pop();
	pressEscape();
	const delayedCancelled = await handleComponentPlaceCheckTask({ sessionId: delayedCancelStart.sessionId });
	assert.equal(delayedCancelled.placed, false);
	assert.equal(delayedCancelled.userCancelled, true);

	// If the ID-only index sees just one of two committed symbols, the object
	// read after exit must still find and remove the duplicate.
	let indexedIds = ['known-existing'];
	const partialComponents = [primitive('known-existing', 'U4')];
	const partialDeleteTargets = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...indexedIds]; },
		async getAll() { return [...partialComponents]; },
		async delete(target) {
			partialDeleteTargets.push(typeof target === 'string' ? 'id' : 'primitive');
			if (typeof target === 'string')
				return false;
			partialComponents.splice(partialComponents.findIndex(component => component.getState_PrimitiveId() === target.getState_PrimitiveId()), 1);
			return true;
		},
		async placeComponentWithMouse() {
			indexedIds = ['known-existing', 'indexed-first'];
			partialComponents.push(placedPrimitive('indexed-first'), placedPrimitive('object-second'));
			return true;
		},
	};
	const partialStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const partialCheck = await handleComponentPlaceCheckTask({ sessionId: partialStart.sessionId });
	assert.equal(partialCheck.placed, true);
	assert.equal(partialCheck.duplicate, false);
	assert.deepEqual(partialCheck.primitiveIds, ['indexed-first']);
	assert.deepEqual(partialCheck.removedDuplicateIds, ['object-second']);
	assert.deepEqual(partialDeleteTargets, ['id', 'primitive']);
	globalThis.eda.sch_PrimitiveComponent = originalPlacementApi;
	const interactiveIds = ['existing-u'];
	const interactiveBom = { Value: 'FM25V20A', Datasheet: 'https://example.test/f' };
	let interactiveDesignator = 'U5';
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...interactiveIds]; },
		async getAll() {
			return interactiveIds.map(id => id === 'existing-u'
				? primitive(id, interactiveDesignator, interactiveBom)
				: placedPrimitive(id));
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
	globalThis.eda.sch_PrimitiveComponent.modify = async () => {
		throw new Error('RPC Call modify Timed Out');
	};
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

	// Some EDA builds accept an ID but only delete the live primitive object.
	const objectOnlyIds = ['existing'];
	const objectOnlyDeleteTargets = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...objectOnlyIds]; },
		async getAll() { return objectOnlyIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(target) {
			objectOnlyDeleteTargets.push(typeof target === 'string' ? 'id' : 'primitive');
			if (typeof target === 'string')
				return false;
			objectOnlyIds.splice(objectOnlyIds.indexOf(target.getState_PrimitiveId()), 1);
			return true;
		},
		async placeComponentWithMouse() {
			objectOnlyIds.push('object-only-1', 'object-only-2');
			return true;
		},
	};
	const objectOnlyStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const objectOnlyCheck = await handleComponentPlaceCheckTask({ sessionId: objectOnlyStart.sessionId });
	assert.equal(objectOnlyCheck.placed, true);
	assert.equal(objectOnlyCheck.duplicate, false);
	assert.deepEqual(objectOnlyCheck.primitiveIds, ['object-only-1']);
	assert.deepEqual(objectOnlyCheck.removedDuplicateIds, ['object-only-2']);
	assert.deepEqual(objectOnlyDeleteTargets, ['id', 'primitive']);
	assert.deepEqual(objectOnlyIds, ['existing', 'object-only-1']);

	const stubbornIds = ['existing'];
	const stubbornDeleteTargets = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...stubbornIds]; },
		async getAll() { return stubbornIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(target) {
			stubbornDeleteTargets.push(typeof target === 'string' ? 'id' : 'primitive');
			return false;
		},
		async placeComponentWithMouse() {
			stubbornIds.push('stubborn-1', 'stubborn-2');
			return true;
		},
	};
	const stubbornStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const stubbornCheck = await handleComponentPlaceCheckTask({ sessionId: stubbornStart.sessionId });
	assert.equal(stubbornCheck.placed, false);
	assert.equal(stubbornCheck.duplicate, true);
	assert.deepEqual(stubbornCheck.primitiveIds, ['stubborn-1', 'stubborn-2']);
	assert.equal(stubbornCheck.removedDuplicateIds, undefined);
	assert.deepEqual(stubbornDeleteTargets, ['id', 'primitive']);
	assert.match(stubbornCheck.annotationWarning, /两种删除方式后仍存在/);

	// A rejected native delete must not be reported as a successful cleanup.
	const rejectedIds = ['existing'];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId() { return [...rejectedIds]; },
		async getAll() { return rejectedIds.map(id => id === 'existing' ? primitive(id, 'U4') : placedPrimitive(id)); },
		async delete(id) {
			rejectedIds.splice(rejectedIds.indexOf(id), 1);
			throw new Error('native delete rejected');
		},
		async placeComponentWithMouse() {
			rejectedIds.push('rejected-1', 'rejected-2');
			return true;
		},
	};
	const rejectedStart = await handleComponentPlaceStartTask({ component: { uuid: 'device', libraryUuid: 'library' } });
	pressEscape();
	const rejectedCheck = await handleComponentPlaceCheckTask({ sessionId: rejectedStart.sessionId });
	assert.equal(rejectedCheck.placed, false);
	assert.equal(rejectedCheck.duplicate, true);
	assert.deepEqual(rejectedCheck.primitiveIds, ['rejected-1']);
	assert.equal(rejectedCheck.removedDuplicateIds, undefined);
	assert.match(rejectedCheck.annotationWarning, /native delete rejected/);

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
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
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

	let timedOutCreateCalls = 0;
	const timedOutCreateComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return timedOutCreateComponents; },
		async create() {
			timedOutCreateCalls += 1;
			if (timedOutCreateCalls === 2)
				throw new Error('RPC Call create Timed Out');
			const created = primitive('first-created', 'R1');
			timedOutCreateComponents.push(created);
			return created;
		},
	};
	const timedOutCreate = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
		{ uuid: 'third', libraryUuid: 'library' },
	] });
	assert.equal(timedOutCreate.ok, false);
	assert.equal(timedOutCreateCalls, 2);
	assert.equal(timedOutCreate.placedCount, 1);
	assert.equal(timedOutCreate.failedCount, 1);
	assert.equal(timedOutCreate.notAttemptedCount, 1);
	assert.deepEqual(timedOutCreate.placedComponents.map(item => item.primitiveId), ['first-created']);
	assert.equal(timedOutCreate.commitUnknown, true);
	assert.equal(timedOutCreate.readbackRequired, true);
	assert.equal(timedOutCreate.nativeCallSettled, false);
	assert.match(timedOutCreate.creationWarning, /Timed Out/);

	let rejectedCreateCalls = 0;
	const rejectedCreateComponents = [];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return rejectedCreateComponents; },
		async create() {
			rejectedCreateCalls += 1;
			if (rejectedCreateCalls === 1)
				throw new Error('Invalid library device');
			const created = primitive('second-created', 'R1');
			rejectedCreateComponents.push(created);
			return created;
		},
	};
	const rejectedCreate = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'invalid', libraryUuid: 'library' },
		{ uuid: 'valid', libraryUuid: 'library' },
	] });
	assert.equal(rejectedCreateCalls, 2);
	assert.equal(rejectedCreate.failedCount, 1);
	assert.equal(rejectedCreate.placedCount, 1);
	assert.equal(rejectedCreate.commitUnknown, undefined);

	for (const returnedId of ['missing-current-page', '']) {
		let createCount = 0;
		globalThis.eda.sch_PrimitiveComponent = {
			async getAll() { return [primitive('existing-u', 'U4')]; },
			async create() {
				createCount += 1;
				return primitive(returnedId, 'R1');
			},
		};
		const unverifiedCreate = await handleComponentPlaceAutoTask({ components: [
			{ uuid: 'first', libraryUuid: 'library' },
			{ uuid: 'second', libraryUuid: 'library' },
		] });
		assert.equal(createCount, 1);
		assert.equal(unverifiedCreate.ok, false);
		assert.equal(unverifiedCreate.needsReview, true);
		assert.equal(unverifiedCreate.placedCount, 0);
		assert.equal(unverifiedCreate.failedCount, 1);
		assert.equal(unverifiedCreate.notAttemptedCount, 1);
		assert.equal(unverifiedCreate.commitUnknown, true);
		assert.equal(unverifiedCreate.readbackRequired, true);
		assert.equal(unverifiedCreate.nativeCallSettled, true);
	}
	let undefinedCreateCalls = 0;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return [primitive('existing-u', 'U4')]; },
		async create() {
			undefinedCreateCalls += 1;
			return undefined;
		},
	};
	const undefinedCreate = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
	] });
	assert.equal(undefinedCreateCalls, 1);
	assert.equal(undefinedCreate.placedCount, 0);
	assert.equal(undefinedCreate.commitUnknown, true);
	assert.equal(undefinedCreate.nativeCallSettled, true);

	currentPageUuid = 'P1';
	let pageDriftCreateCalls = 0;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return [primitive('existing-u', 'U4')]; },
		async create() {
			pageDriftCreateCalls += 1;
			currentPageUuid = 'P2';
			return primitive('new-r', 'R1');
		},
	};
	const switchedPageCreate = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
	] });
	assert.equal(pageDriftCreateCalls, 1);
	assert.equal(switchedPageCreate.placedCount, 0);
	assert.equal(switchedPageCreate.commitUnknown, true);
	assert.equal(switchedPageCreate.nativeCallSettled, true);
	assert.match(switchedPageCreate.creationWarning, /图页已切换/);
	currentPageUuid = 'P1';
	const originalPageInfo = globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo;
	let pageReads = 0;
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = async () => ({ uuid: ++pageReads <= 4 ? 'P1' : 'P2' });
	let prewriteCreateCalls = 0;
	const prewriteComponents = [primitive('existing-u', 'U4')];
	globalThis.eda.sch_PrimitiveComponent = {
		async getAll() { return prewriteComponents; },
		async create() {
			prewriteCreateCalls += 1;
			const created = primitive('first-r', 'R1');
			prewriteComponents.push(created);
			return created;
		},
	};
	const prewritePageChange = await handleComponentPlaceAutoTask({ components: [
		{ uuid: 'first', libraryUuid: 'library' },
		{ uuid: 'second', libraryUuid: 'library' },
	] });
	assert.equal(prewriteCreateCalls, 1);
	assert.equal(prewritePageChange.placedCount, 1);
	assert.equal(prewritePageChange.notAttemptedCount, 1);
	assert.match(prewritePageChange.pageWarning, /图页已切换/);
	assert.equal(prewritePageChange.commitUnknown, undefined);
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = originalPageInfo;

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
	assert.equal(uncertainPlacement.placedCount, 0);
	assert.equal(uncertainPlacement.failedCount, 1);
	assert.equal(uncertainPlacement.notAttemptedCount, 1);
	assert.equal(uncertainPlacement.commitUnknown, true);
	assert.equal(uncertainPlacement.nativeCallSettled, true);
}

main().then(() => console.log('schematic component issue tests passed')).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
