const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleComponentMoveTask } = require('../src/mcp/component-move-handler.ts');

// 构造可控的 mock 器件图元，用于在不依赖 EDA 的前提下验证 builder 式提交语义。
function createMockPrimitive(options = {}) {
	const calls = [];
	const state = {};
	const omit = new Set(options.omit || []);
	let commitTarget = null;

	const primitive = {
		getState_PrimitiveId: () => options.primitiveId || 'mock-primitive',
		getState_X: () => state.x,
		getState_Y: () => state.y,
		getState_Rotation: () => state.rotation,
		setState_X(x) {
			calls.push(['setState_X', x]);
			state.x = x;
			return this;
		},
		setState_Y(y) {
			calls.push(['setState_Y', y]);
			state.y = y;
			return this;
		},
		setState_Rotation(rotation) {
			calls.push(['setState_Rotation', rotation]);
			state.rotation = rotation;
			return this;
		},
		async done() {
			calls.push(['done']);
			commitTarget = this;
			state.committed = true;
			return this;
		},
	};

	for (const method of omit) {
		delete primitive[method];
	}

	// builder 返回 undefined：调用方必须退回原对象继续链式调用。
	if (options.builderReturnsUndefined) {
		primitive.setState_X = function setStateX(x) {
			calls.push(['setState_X', x]);
			state.x = x;
			return undefined;
		};
		primitive.setState_Y = function setStateY(y) {
			calls.push(['setState_Y', y]);
			state.y = y;
			return undefined;
		};
	}

	// builder 返回新对象：done() 必须在新对象（链尾）上提交。
	if (options.builderReturnsNewObject) {
		const chained = {
			setState_Y(y) {
				calls.push(['chain.setState_Y', y]);
				state.y = y;
				return this;
			},
			async done() {
				calls.push(['chain.done']);
				commitTarget = this;
				state.committed = true;
				return this;
			},
		};
		primitive.setState_X = function setStateX(x) {
			calls.push(['setState_X', x]);
			state.x = x;
			return chained;
		};
	}

	return {
		primitive,
		calls,
		state,
		getCommitTarget: () => commitTarget,
	};
}

// 安装 mock EDA 环境。
function installEdaRuntime(primitiveById) {
	const requestedIds = [];
	globalThis.eda = {
		sch_PrimitiveComponent: {
			get: async (primitiveId) => {
				requestedIds.push(primitiveId);
				return primitiveById[primitiveId];
			},
		},
	};
	return requestedIds;
}

async function main() {
	// 1. 正常路径：坐标与旋转写入后由 done() 提交。
	const first = createMockPrimitive({ primitiveId: 'comp-1' });
	const second = createMockPrimitive({ primitiveId: 'comp-2' });
	installEdaRuntime({ 'comp-1': first.primitive, 'comp-2': second.primitive });

	const moved = await handleComponentMoveTask({
		moves: [
			{ primitiveId: 'comp-1', x: 400, y: 300, rotation: 90 },
			{ primitiveId: 'comp-2', x: -12.5, y: 0 },
		],
	});
	assert.equal(moved.ok, true);
	assert.equal(moved.requested, 2);
	assert.equal(moved.succeeded, 2);
	assert.equal(moved.failed, 0);
	assert.deepEqual(moved.moves, [
		{ primitiveId: 'comp-1', status: 'ok', x: 400, y: 300, rotation: 90 },
		{ primitiveId: 'comp-2', status: 'ok', x: -12.5, y: 0 },
	]);
	assert.deepEqual(first.calls, [['setState_X', 400], ['setState_Y', 300], ['setState_Rotation', 90], ['done']]);
	assert.equal(first.state.committed, true);
	assert.equal(first.state.x, 400);
	assert.equal(first.state.y, 300);
	assert.equal(first.state.rotation, 90);
	assert.equal(first.getCommitTarget(), first.primitive, 'done() must commit on the builder target');
	// 未请求 rotation 时不得调用 setState_Rotation。
	assert.deepEqual(second.calls, [['setState_X', -12.5], ['setState_Y', 0], ['done']]);

	// 2. builder 返回 undefined 时退回原对象，仍然提交。
	const undefinedBuilder = createMockPrimitive({ primitiveId: 'comp-undefined', builderReturnsUndefined: true });
	installEdaRuntime({ 'comp-undefined': undefinedBuilder.primitive });
	const undefinedResult = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-undefined', x: 11, y: 22 }],
	});
	assert.equal(undefinedResult.ok, true);
	assert.deepEqual(undefinedBuilder.calls, [['setState_X', 11], ['setState_Y', 22], ['done']]);
	assert.equal(undefinedBuilder.state.committed, true);
	assert.equal(undefinedBuilder.getCommitTarget(), undefinedBuilder.primitive);

	// 3. builder 返回新对象时，在新对象上继续链式调用并提交。
	const newObjectBuilder = createMockPrimitive({ primitiveId: 'comp-chain', builderReturnsNewObject: true });
	installEdaRuntime({ 'comp-chain': newObjectBuilder.primitive });
	const chainResult = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-chain', x: 5, y: 6 }],
	});
	assert.equal(chainResult.ok, true);
	assert.deepEqual(newObjectBuilder.calls, [['setState_X', 5], ['chain.setState_Y', 6], ['chain.done']]);
	assert.notEqual(newObjectBuilder.getCommitTarget(), newObjectBuilder.primitive);

	// 4. 缺少 done()：该项明确失败，其余器件继续执行。
	const missingDone = createMockPrimitive({ primitiveId: 'comp-no-done', omit: ['done'] });
	const healthyNeighbour = createMockPrimitive({ primitiveId: 'comp-healthy' });
	installEdaRuntime({ 'comp-no-done': missingDone.primitive, 'comp-healthy': healthyNeighbour.primitive });
	const missingDoneResult = await handleComponentMoveTask({
		moves: [
			{ primitiveId: 'comp-no-done', x: 1, y: 2 },
			{ primitiveId: 'comp-healthy', x: 3, y: 4 },
		],
	});
	assert.equal(missingDoneResult.ok, false);
	assert.equal(missingDoneResult.succeeded, 1);
	assert.equal(missingDoneResult.failed, 1);
	assert.equal(missingDoneResult.moves[0].status, 'failed');
	assert.match(missingDoneResult.moves[0].error, /done/);
	assert.equal(missingDoneResult.moves[1].status, 'ok');
	assert.equal(healthyNeighbour.state.committed, true, 'one bad primitive must not block the rest of the batch');

	// 5. 缺少 setState_X / setState_Y：抛出可读的 TypeError。
	const noSetters = createMockPrimitive({ primitiveId: 'comp-no-setter', omit: ['setState_X'] });
	installEdaRuntime({ 'comp-no-setter': noSetters.primitive });
	const noSetterResult = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-no-setter', x: 1, y: 2 }],
	});
	assert.equal(noSetterResult.failed, 1);
	assert.match(noSetterResult.moves[0].error, /setState_X/);

	// 6. 请求 rotation 但 SDK 不支持：明确失败且不得只写入部分状态。
	const noRotation = createMockPrimitive({ primitiveId: 'comp-no-rotation', omit: ['setState_Rotation'] });
	installEdaRuntime({ 'comp-no-rotation': noRotation.primitive });
	const noRotationResult = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-no-rotation', x: 7, y: 8, rotation: 180 }],
	});
	assert.equal(noRotationResult.ok, false);
	assert.equal(noRotationResult.failed, 1);
	assert.match(noRotationResult.moves[0].error, /setState_Rotation/);
	assert.deepEqual(noRotation.calls, [], 'an unsupported rotation must not partially mutate the primitive');
	assert.equal(noRotation.state.committed, undefined);
	// 不请求 rotation 时，缺少 setState_Rotation 不应影响移动。
	const noRotationMove = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-no-rotation', x: 7, y: 8 }],
	});
	assert.equal(noRotationMove.ok, true);
	assert.deepEqual(noRotation.calls, [['setState_X', 7], ['setState_Y', 8], ['done']]);

	// 7. 图元 ID 不存在：逐项失败，其余器件仍然移动。
	const survivor = createMockPrimitive({ primitiveId: 'comp-survivor' });
	const requestedIds = installEdaRuntime({ 'comp-survivor': survivor.primitive });
	const missingIdResult = await handleComponentMoveTask({
		moves: [
			{ primitiveId: 'does-not-exist', x: 1, y: 1 },
			{ primitiveId: 'comp-survivor', x: 2, y: 2 },
		],
	});
	assert.deepEqual(requestedIds, ['does-not-exist', 'comp-survivor']);
	assert.equal(missingIdResult.ok, false);
	assert.equal(missingIdResult.succeeded, 1);
	assert.equal(missingIdResult.failed, 1);
	assert.equal(missingIdResult.moves[0].status, 'failed');
	assert.match(missingIdResult.moves[0].error, /does-not-exist/);
	assert.equal(missingIdResult.moves[0].primitiveId, 'does-not-exist');
	assert.equal(survivor.state.committed, true);

	// 8. done() 返回 Promise 时必须等待其结算。
	const deferred = createMockPrimitive({ primitiveId: 'comp-async-done' });
	const order = [];
	deferred.primitive.done = function done() {
		deferred.calls.push(['done']);
		return Promise.resolve().then(() => {
			order.push('settled');
			deferred.state.committed = true;
			return deferred.primitive;
		});
	};
	installEdaRuntime({ 'comp-async-done': deferred.primitive });
	const asyncDoneResult = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-async-done', x: 9, y: 9 }],
	});
	order.push('handler-returned');
	assert.equal(asyncDoneResult.ok, true);
	assert.deepEqual(order, ['settled', 'handler-returned'], 'the handler must await an asynchronous done()');

	// 9. 参数校验。
	await assert.rejects(() => handleComponentMoveTask(null), /component\/move 任务参数必须为对象/);
	await assert.rejects(() => handleComponentMoveTask('moves'), /component\/move 任务参数必须为对象/);
	await assert.rejects(() => handleComponentMoveTask({}), /moves 参数/);
	await assert.rejects(() => handleComponentMoveTask({ moves: {} }), /moves 参数/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [] }), /moves 不能为空/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [null] }), /moves\[0\] 必须为对象/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ x: 1, y: 2 }] }), /primitiveId 不能为空/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: '   ', x: 1, y: 2 }] }), /primitiveId 不能为空/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', y: 2 }] }), /moves\[0\]\.x 必须为有限数字/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', x: 1 }] }), /moves\[0\]\.y 必须为有限数字/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', x: Number.NaN, y: 2 }] }), /moves\[0\]\.x 必须为有限数字/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', x: Number.POSITIVE_INFINITY, y: 2 }] }), /moves\[0\]\.x 必须为有限数字/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', x: null, y: 2 }] }), /moves\[0\]\.x 必须为有限数字/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', x: 1, y: 2, rotation: 'left' }] }), /rotation 必须为有限数字/);
	await assert.rejects(() => handleComponentMoveTask({ moves: [{ primitiveId: 'c', x: 1, y: 2, rotation: 45 }] }), /rotation 只能为 0、90、180、270/);
	await assert.rejects(
		() => handleComponentMoveTask({ moves: Array.from({ length: 101 }, () => ({ primitiveId: 'c', x: 1, y: 2 })) }),
		/moves 数量过多/,
	);
	// 数字字符串可被接受，保持与 component_place_auto 一致的宽松转换。
	const stringCoordinates = createMockPrimitive({ primitiveId: 'comp-string' });
	installEdaRuntime({ 'comp-string': stringCoordinates.primitive });
	const stringResult = await handleComponentMoveTask({
		moves: [{ primitiveId: 'comp-string', x: '400', y: '300' }],
	});
	assert.equal(stringResult.ok, true);
	assert.deepEqual(stringCoordinates.calls, [['setState_X', 400], ['setState_Y', 300], ['done']]);
}

main().then(() => {
	process.stdout.write('Component move handler tests passed\n');
	process.exit(0);
}).catch((error) => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exit(1);
});
