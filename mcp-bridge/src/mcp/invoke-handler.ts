/**
 * ------------------------------------------------------------------------
 * 名称：桥接 API 调用任务处理
 * 说明：解析调用路径并执行对应 EDA API。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-12
 * 备注：仅处理 api/invoke 任务。
 * ------------------------------------------------------------------------
 */

import { isPlainObjectRecord, toSafeErrorMessage, toSerializableAsync } from '../utils';

const PCB_AUTO_LAYOUT = 'eda.pcb_document.autolayout';
const PCB_AUTO_ROUTING = 'eda.pcb_document.autorouting';
const PCB_COMPONENT_GET_ALL = 'eda.pcb_primitivecomponent.getall';
let pcbAutoLayoutReadbackRequired = false;

// 在对象上解析段名，要求精确匹配。
function resolveSegmentKey(target: Record<string, unknown>, segment: string): string {
	if (segment in target) {
		return segment;
	}

	const normalizedSegment = segment.toLowerCase();
	for (const key of Object.keys(target)) {
		if (key.toLowerCase() !== normalizedSegment) {
			continue;
		}
		return key;
	}

	throw new Error(`调用路径不存在: ${segment}`);
}

// 禁止访问的 JS 内置属性名，防止 prototype pollution。
const FORBIDDEN_SEGMENT_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

// 解析调用目标。
function resolveApiCallable(apiFullName: string): { callable: (...args: unknown[]) => unknown; thisArg: unknown; resolvedPath: string } {
	const normalized = apiFullName.trim();
	if (normalized.length === 0) {
		throw new Error('缺少 apiFullName。');
	}

	const segments = normalized.split('.');
	if (segments.length < 3 || segments.some(item => item.length === 0)) {
		throw new Error(`apiFullName 格式非法: "${apiFullName}"。正确格式为 eda.模块名.方法名（以“.”分隔的至少三段路径）。`);
	}

	if (segments.some(s => FORBIDDEN_SEGMENT_NAMES.has(s))) {
		throw new Error(`apiFullName 包含非法属性名。`);
	}

	let current: unknown = eda;
	for (let index = 1; index < segments.length - 1; index += 1) {
		if (!isPlainObjectRecord(current)) {
			throw new Error(`调用路径无效: ${normalized}`);
		}

		const segment = segments[index];
		const segmentKey = resolveSegmentKey(current, segment);
		current = current[segmentKey];
	}

	if (!isPlainObjectRecord(current)) {
		throw new Error(`调用目标无效: ${apiFullName}`);
	}

	const methodKey = resolveSegmentKey(current, segments[segments.length - 1]);
	const callable = current[methodKey];
	if (typeof callable !== 'function') {
		throw new TypeError(`目标不可调用: ${apiFullName}`);
	}

	return {
		callable: callable as (...args: unknown[]) => unknown,
		thisArg: current,
		resolvedPath: normalized,
	};
}

/**
 * 处理 API 调用任务。
 * @param payload 任务参数。
 * @returns 调用结果。
 */
export async function handleApiInvokeTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new Error('invoke 任务参数必须为对象。');
	}

	const apiFullName = String(payload.apiFullName ?? '').trim();
	const { callable, thisArg, resolvedPath } = resolveApiCallable(apiFullName);
	const invokeArgs = Array.isArray(payload.args) ? payload.args : [];
	const normalizedPath = resolvedPath.toLowerCase();
	if (normalizedPath === PCB_AUTO_LAYOUT && pcbAutoLayoutReadbackRequired) {
		return {
			apiFullName: resolvedPath,
			ok: false,
			commitState: 'unknown',
			retryBlocked: true,
			verification: 'Read back PCB component positions with eda.pcb_PrimitiveComponent.getAll before another autoLayout call.',
		};
	}
	let invokeResult: unknown;
	try {
		invokeResult = await Promise.resolve(callable.apply(thisArg, invokeArgs));
	}
	catch (error: unknown) {
		if (normalizedPath === PCB_AUTO_LAYOUT && /RPC Call autoLayout Timed Out/i.test(toSafeErrorMessage(error))) {
			pcbAutoLayoutReadbackRequired = true;
			return {
				apiFullName: resolvedPath,
				ok: false,
				commitState: 'unknown',
				retryBlocked: true,
				error: toSafeErrorMessage(error),
				verification: 'Auto layout may still commit. Read back PCB component positions with eda.pcb_PrimitiveComponent.getAll before retrying.',
			};
		}
		throw error;
	}
	if (normalizedPath === PCB_COMPONENT_GET_ALL && pcbAutoLayoutReadbackRequired && Array.isArray(invokeResult)) {
		pcbAutoLayoutReadbackRequired = false;
		return {
			apiFullName: resolvedPath,
			result: await toSerializableAsync(invokeResult),
			autoLayoutReadbackPerformed: true,
			verification: 'Compare these component positions and rotations with the pre-layout snapshot before deciding whether to retry.',
		};
	}
	if (normalizedPath === PCB_AUTO_ROUTING && isPlainObjectRecord(invokeResult) && invokeResult.success === false) {
		return {
			apiFullName: resolvedPath,
			result: await toSerializableAsync(invokeResult),
			ok: false,
			routingState: invokeResult.successNetsCount === 0 && invokeResult.duration === 0 ? 'not_started' : 'incomplete',
			verification: 'Check PCB tracks, vias, and DRC before treating this routing attempt as complete.',
		};
	}

	return {
		apiFullName: resolvedPath,
		result: await toSerializableAsync(invokeResult),
	};
}
