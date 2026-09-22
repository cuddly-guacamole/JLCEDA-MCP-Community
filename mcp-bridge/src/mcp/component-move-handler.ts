/**
 * ------------------------------------------------------------------------
 * 名称：桥接器件移动任务处理
 * 说明：将原理图中已存在的器件图元移动到指定坐标，可选同时设置旋转角度。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-09-22
 * 备注：仅处理 component/move 任务；每个器件独立提交，单项失败不影响其余器件。
 * ------------------------------------------------------------------------
 */

import { isPlainObjectRecord, toSafeErrorMessage } from '../utils';

interface ComponentMoveItem {
	primitiveId: string;
	x: number;
	y: number;
	rotation?: number;
}

interface ComponentApi {
	context: unknown;
	get: (primitiveId: string) => Promise<unknown>;
}

type PrimitiveSetter = (...args: Array<unknown>) => unknown;

const ALLOWED_ROTATIONS = [0, 90, 180, 270];
const MAX_MOVE_COUNT = 100;

// 解析 EDA 器件 API。
function resolveComponentApi(): ComponentApi {
	const componentModule = eda.sch_PrimitiveComponent;
	if (
		!isPlainObjectRecord(componentModule)
		|| typeof componentModule.get !== 'function'
	) {
		throw new Error('未找到 eda.sch_PrimitiveComponent.get API。');
	}

	return {
		context: componentModule,
		get: componentModule.get as (primitiveId: string) => Promise<unknown>,
	};
}

// 读取图元方法，缺失时返回 undefined。
function readPrimitiveMethod(target: unknown, method: string): PrimitiveSetter | undefined {
	const candidate = (target as Record<string, unknown> | null | undefined)?.[method];
	return typeof candidate === 'function' ? (candidate as PrimitiveSetter) : undefined;
}

// 将参数转换为有限数字，非法输入返回 undefined。
function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}

	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

// 解析单条器件移动参数。
function normalizeComponentMoveItem(raw: unknown, index: number): ComponentMoveItem {
	if (!isPlainObjectRecord(raw)) {
		throw new TypeError(`moves[${String(index)}] 必须为对象。`);
	}

	const primitiveId = String(raw.primitiveId ?? '').trim();
	if (primitiveId.length === 0) {
		throw new Error(`moves[${String(index)}].primitiveId 不能为空。`);
	}

	const x = toFiniteNumber(raw.x);
	if (x === undefined) {
		throw new TypeError(`moves[${String(index)}].x 必须为有限数字。`);
	}

	const y = toFiniteNumber(raw.y);
	if (y === undefined) {
		throw new TypeError(`moves[${String(index)}].y 必须为有限数字。`);
	}

	const item: ComponentMoveItem = { primitiveId, x, y };

	if (raw.rotation !== undefined && raw.rotation !== null) {
		const rotation = toFiniteNumber(raw.rotation);
		if (rotation === undefined) {
			throw new TypeError(`moves[${String(index)}].rotation 必须为有限数字。`);
		}
		if (!ALLOWED_ROTATIONS.includes(rotation)) {
			throw new Error(`moves[${String(index)}].rotation 只能为 0、90、180、270。`);
		}
		item.rotation = rotation;
	}

	return item;
}

// 调用 builder 式 setter 并返回后续链式调用目标：返回空时退回原对象。
function applyStateSetter(target: unknown, setter: PrimitiveSetter, value: number): unknown {
	const updated = setter.call(target, value);
	const isUsableTarget = updated !== null
		&& (typeof updated === 'object' || typeof updated === 'function');

	return isUsableTarget ? updated : target;
}

/**
 * 提交单个器件的位置变更。
 * @param primitive 器件图元对象。
 * @param item 移动参数。
 * @remarks setState_* 为 builder 式调用，只有 done() 才真正提交改动。
 */
async function moveComponentPrimitive(primitive: unknown, item: ComponentMoveItem): Promise<void> {
	// 先探测全部需要的方法，避免只写入部分状态。
	const setStateX = readPrimitiveMethod(primitive, 'setState_X');
	const setStateY = readPrimitiveMethod(primitive, 'setState_Y');
	if (!setStateX || !setStateY) {
		throw new TypeError('当前 EDA SDK 返回的器件图元不支持 setState_X/setState_Y，无法移动器件。');
	}

	const setStateRotation = readPrimitiveMethod(primitive, 'setState_Rotation');
	if (item.rotation !== undefined && !setStateRotation) {
		throw new TypeError('当前 EDA SDK 返回的器件图元不支持 setState_Rotation，rotation 无法生效。');
	}

	let updateTarget = primitive;
	const steps: Array<{ method: string; fallback: PrimitiveSetter; value: number }> = [
		{ method: 'setState_X', fallback: setStateX, value: item.x },
		{ method: 'setState_Y', fallback: setStateY, value: item.y },
	];
	if (item.rotation !== undefined && setStateRotation) {
		steps.push({ method: 'setState_Rotation', fallback: setStateRotation, value: item.rotation });
	}

	// builder 式链式调用：每一步优先使用链上对象自身的方法，缺失时退回已探测到的方法。
	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index];
		const setter = readPrimitiveMethod(updateTarget, step.method) ?? step.fallback;
		updateTarget = applyStateSetter(updateTarget, setter, step.value);
	}

	const done = readPrimitiveMethod(updateTarget, 'done');
	if (!done) {
		throw new TypeError('当前 EDA SDK 返回的器件图元不支持 done，改动无法提交。');
	}

	await Promise.resolve(done.call(updateTarget));
}

/**
 * 处理器件移动任务。
 * @param payload 任务参数。
 * @returns 逐项移动结果。
 */
export async function handleComponentMoveTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/move 任务参数必须为对象。');
	}

	const rawMoves = payload.moves;
	if (!Array.isArray(rawMoves)) {
		throw new TypeError('缺少 moves 参数，且其必须为数组。');
	}
	if (rawMoves.length < 1) {
		throw new Error('moves 不能为空，至少需要提供一个待移动器件。');
	}
	if (rawMoves.length > MAX_MOVE_COUNT) {
		throw new Error(`moves 数量过多，单次最多允许 ${String(MAX_MOVE_COUNT)} 个器件。`);
	}

	const moves = rawMoves.map((item: unknown, index: number) =>
		normalizeComponentMoveItem(item, index),
	);

	const api = resolveComponentApi();
	const results: Array<Record<string, unknown>> = [];
	let succeeded = 0;

	for (let index = 0; index < moves.length; index += 1) {
		const move = moves[index];

		// 单个器件失败不影响其余器件，逐项返回状态。
		try {
			const primitive = await Promise.resolve(api.get.call(api.context, move.primitiveId));
			if (primitive === undefined || primitive === null) {
				throw new Error(`未找到图元 ID 为 "${move.primitiveId}" 的器件。`);
			}

			await moveComponentPrimitive(primitive, move);

			succeeded += 1;
			results.push({
				primitiveId: move.primitiveId,
				status: 'ok',
				x: move.x,
				y: move.y,
				...(move.rotation === undefined ? {} : { rotation: move.rotation }),
			});
		}
		catch (error: unknown) {
			results.push({
				primitiveId: move.primitiveId,
				status: 'failed',
				error: toSafeErrorMessage(error),
			});
		}
	}

	const failed = results.length - succeeded;

	return {
		ok: failed === 0,
		requested: moves.length,
		succeeded,
		failed,
		moves: results,
		message: `移动了 ${String(succeeded)} 个器件，${String(failed)} 个失败。`,
	};
}
