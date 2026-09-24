const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleComponentPlaceAutoTask } = require('../src/mcp/component-place-auto-handler.ts');
const {
	handleComponentPlaceTask,
	handleComponentPlaceStartTask,
	handleComponentPlaceCheckTask,
} = require('../src/mcp/component-place-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');

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
	globalThis.eda = {
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
	ids.splice(ids.indexOf('floating-1'), 1);
	ids.push('placed-1');
	pressEscape();
	const check = await handleComponentPlaceCheckTask({ sessionId: start.sessionId });
	assert.equal(check.placed, true);
	assert.deepEqual(check.primitiveIds, ['placed-1']);

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
