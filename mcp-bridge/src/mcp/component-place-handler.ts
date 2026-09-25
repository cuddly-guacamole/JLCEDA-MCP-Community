/**
 * ------------------------------------------------------------------------
 * 名称：桥接器件放置任务处理
 * 说明：校验待放置器件参数，并提供放置会话启动、轮询和清理能力。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-24
 * 备注：仅处理 component/place 任务。
 * ------------------------------------------------------------------------
 */

import type { DesignatorChange } from './component-designator-restore';
import { getEdaRuntime, getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils';
import { readSchematicDesignators, restoreChangedSchematicDesignators } from './component-designator-restore';

interface ComponentPlaceItem {
	uuid: string;
	libraryUuid: string;
	name: string;
	footprintName: string;
	subPartName: string;
}

interface ComponentPlaceRequest {
	protocol: string;
	title: string;
	description: string;
	components: ComponentPlaceItem[];
	timeoutSeconds: number;
}

interface PlaceComponentApi {
	context: unknown;
	placeComponentWithMouse: (component: { libraryUuid: string; uuid: string }, subPartName?: string) => Promise<boolean>;
	getAllPrimitiveId: (componentType?: unknown, allSchematicPages?: boolean) => Promise<string[]>;
	getAll: (componentType?: unknown, allSchematicPages?: boolean) => Promise<unknown[]>;
	delete?: (primitive: string | object) => Promise<boolean>;
	modify?: (primitiveId: string, property: { designator: string; otherProperty: Record<string, string | number | boolean> }) => Promise<unknown>;
}

interface PlacedComponentState {
	libraryUuid: string;
	uuid: string;
	subPartName: string;
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
}

interface FollowMouseTipApi {
	context: unknown;
	show: (tip: string, msTimeout?: number) => Promise<void>;
	remove: (tip?: string) => Promise<void>;
}

interface ActivePlaceSession {
	sessionId: string;
	component: ComponentPlaceItem;
	pageUuid: string;
	referenceIds: Set<string>;
	baselineDesignators: Map<string, string>;
	tipText: string;
	followMouseTipApi: FollowMouseTipApi | null;
	placeApi: PlaceComponentApi;
	createdAt: number;
	placementExited: boolean;
	cancelHandler: ((event: Event) => void) | null;
	escapeHandler: ((event: Event) => void) | null;
}

const COMPONENT_PLACE_PROTOCOL = 'component-place/v1';
const activePlaceSessions = new Map<string, ActivePlaceSession>();
let placeSessionGeneration = 0;
let placementModeNeedsExit = false;
let removeExitGuardListeners: (() => void) | null = null;

/** EDA 原生交互放置模式退出前禁止新的写任务。 */
export function isPlacementModeExitRequired(): boolean {
	return placementModeNeedsExit;
}

/** 交互放置会话结束前，其他写任务不能与 EDA 鼠标模式并行。 */
export function isInteractivePlacementActive(): boolean {
	return activePlaceSessions.size > 0;
}

async function readCurrentSchematicPageUuid(): Promise<string> {
	const schematicModule = getEdaRuntime()?.dmt_Schematic;
	if (!isPlainObjectRecord(schematicModule) || typeof schematicModule.getCurrentSchematicPageInfo !== 'function') {
		throw new Error('无法读取当前原理图图页身份。');
	}
	const page = await Promise.resolve((schematicModule.getCurrentSchematicPageInfo as () => Promise<unknown>).call(schematicModule));
	const pageUuid = isPlainObjectRecord(page) && typeof page.uuid === 'string' ? page.uuid.trim() : '';
	if (!pageUuid) {
		throw new Error('当前未打开原理图图页。');
	}
	return pageUuid;
}

async function assertPlaceSessionPage(pageUuid: string): Promise<void> {
	if (await readCurrentSchematicPageUuid() !== pageUuid) {
		throw new Error('原理图图页已切换；请回到原图页核对放置结果，本批次已停止。');
	}
}

function requirePlacementModeExit(): void {
	if (placementModeNeedsExit) {
		return;
	}
	placementModeNeedsExit = true;
	const docRef = (globalThis as unknown as { document?: Document }).document;
	if (!docRef) {
		return;
	}
	const clearGuard = (): void => {
		placementModeNeedsExit = false;
		removeExitGuardListeners?.();
		removeExitGuardListeners = null;
	};
	const onMouseUp = (event: Event): void => {
		if ((event as MouseEvent).button === 2) {
			clearGuard();
		}
	};
	const onKeyUp = (event: Event): void => {
		if ((event as KeyboardEvent).key === 'Escape') {
			clearGuard();
		}
	};
	docRef.addEventListener('mouseup', onMouseUp, { capture: true });
	docRef.addEventListener('keyup', onKeyUp, { capture: true });
	removeExitGuardListeners = () => {
		docRef.removeEventListener('mouseup', onMouseUp, { capture: true });
		docRef.removeEventListener('keyup', onKeyUp, { capture: true });
	};
}

function createPlaceSessionId(): string {
	return `component_place_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// 规范化单个待放置器件参数。
function normalizeComponentPlaceItem(raw: unknown, index: number): ComponentPlaceItem {
	if (!isPlainObjectRecord(raw)) {
		throw new TypeError(`components[${String(index)}] 必须为对象。`);
	}

	const uuid = String(raw.uuid ?? '').trim();
	const libraryUuid = String(raw.libraryUuid ?? '').trim();
	if (uuid.length === 0) {
		throw new Error(`components[${String(index)}].uuid 不能为空。`);
	}
	if (libraryUuid.length === 0) {
		throw new Error(`components[${String(index)}].libraryUuid 不能为空。`);
	}

	return {
		uuid,
		libraryUuid,
		name: String(raw.name ?? '').trim(),
		footprintName: String(raw.footprintName ?? '').trim(),
		subPartName: String(raw.subPartName ?? '').trim(),
	};
}

// 解析超时参数。
function resolveTimeoutSeconds(rawValue: unknown): number {
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return 60;
	}

	const timeoutSeconds = Number(rawValue);
	if (!Number.isFinite(timeoutSeconds)) {
		throw new TypeError('timeoutSeconds 必须为数字。');
	}
	if (!Number.isInteger(timeoutSeconds)) {
		throw new TypeError('timeoutSeconds 必须为整数。');
	}
	if (timeoutSeconds < 30 || timeoutSeconds > 180) {
		throw new Error('timeoutSeconds 超出允许范围，必须在 30 到 180 秒之间。');
	}

	return timeoutSeconds;
}

function formatComponentTitle(component: ComponentPlaceItem): string {
	if (component.name.length > 0) {
		return component.name;
	}

	return `${component.libraryUuid}/${component.uuid}`;
}

function isUnknownPlacementStartResult(errorMessage: string): boolean {
	return /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i.test(errorMessage);
}

function resolvePlaceComponentApi(): PlaceComponentApi {
	const edaGlobal = getEdaRuntime();
	if (!edaGlobal || typeof edaGlobal !== 'object') {
		throw new Error('EDA 环境未就绪，无法访问 eda 全局对象。');
	}

	const componentModule = (edaGlobal as { sch_PrimitiveComponent?: unknown }).sch_PrimitiveComponent;
	if (!isPlainObjectRecord(componentModule)
		|| typeof componentModule.placeComponentWithMouse !== 'function'
		|| typeof componentModule.getAllPrimitiveId !== 'function'
		|| typeof componentModule.getAll !== 'function') {
		throw new Error('未找到 eda.sch_PrimitiveComponent.placeComponentWithMouse/getAll API。');
	}

	return {
		context: componentModule,
		placeComponentWithMouse: componentModule.placeComponentWithMouse as (component: { libraryUuid: string; uuid: string }, subPartName?: string) => Promise<boolean>,
		getAllPrimitiveId: componentModule.getAllPrimitiveId as PlaceComponentApi['getAllPrimitiveId'],
		getAll: componentModule.getAll as PlaceComponentApi['getAll'],
		delete: typeof componentModule.delete === 'function' ? componentModule.delete as PlaceComponentApi['delete'] : undefined,
		modify: typeof componentModule.modify === 'function' ? componentModule.modify as PlaceComponentApi['modify'] : undefined,
	};
}

function readPlacedComponentState(primitive: unknown): PlacedComponentState | undefined {
	const component = getSyncState<unknown>(primitive, 'getState_Component', null);
	// Single-part symbols legitimately return undefined for this optional state.
	const subPartName = getSyncState<unknown>(primitive, 'getState_SubPartName', '');
	const x = getSyncState<unknown>(primitive, 'getState_X', null);
	const y = getSyncState<unknown>(primitive, 'getState_Y', null);
	const rotation = getSyncState<unknown>(primitive, 'getState_Rotation', null);
	const mirror = getSyncState<unknown>(primitive, 'getState_Mirror', null);
	if (!isPlainObjectRecord(component)
		|| typeof component.libraryUuid !== 'string' || !component.libraryUuid
		|| typeof component.uuid !== 'string' || !component.uuid
		|| typeof subPartName !== 'string'
		|| typeof x !== 'number' || !Number.isFinite(x)
		|| typeof y !== 'number' || !Number.isFinite(y)
		|| typeof rotation !== 'number' || !Number.isFinite(rotation)
		|| typeof mirror !== 'boolean') {
		return undefined;
	}
	return { libraryUuid: component.libraryUuid, uuid: component.uuid, subPartName, x, y, rotation, mirror };
}

function samePlacedComponent(a: PlacedComponentState, b: PlacedComponentState): boolean {
	return a.libraryUuid === b.libraryUuid && a.uuid === b.uuid && a.subPartName === b.subPartName
		&& a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.mirror === b.mirror;
}

async function cleanupExactPlacementDuplicates(
	session: ActivePlaceSession,
	primitiveIds: string[],
): Promise<{ primitiveIds: string[]; removedDuplicateIds?: string[]; warning?: string; commitUnknown?: boolean; nativeCallSettled?: boolean }> {
	const api = session.placeApi;
	if (!api.delete)
		return { primitiveIds, warning: '检测到多个新增器件，但当前 EDA 未提供删除 API；请检查重叠器件。' };
	try {
		await assertPlaceSessionPage(session.pageUuid);
		const all = await Promise.resolve(api.getAll.call(api.context, undefined, false));
		await assertPlaceSessionPage(session.pageUuid);
		if (!Array.isArray(all))
			throw new TypeError('EDA 未返回器件列表。');
		const newPrimitives = all.filter(item => primitiveIds.includes(getSyncState(item, 'getState_PrimitiveId', '')));
		if (newPrimitives.length !== primitiveIds.length)
			return { primitiveIds, warning: '无法逐一读取新增器件，已保留重复器件供人工核对。' };
		const states = newPrimitives.map(readPlacedComponentState);
		const first = states[0];
		if (!first || states.some(state => !state || !samePlacedComponent(first, state))
			|| first.libraryUuid !== session.component.libraryUuid || first.uuid !== session.component.uuid
			|| (session.component.subPartName && first.subPartName !== session.component.subPartName)) {
			return { primitiveIds, warning: '新增器件的型号、子部件或位置不同，已保留多个器件供人工核对。' };
		}
	}
	catch (error: unknown) {
		return { primitiveIds, warning: `无法核对新增器件，已保留重复器件：${toSafeErrorMessage(error)}` };
	}

	const retainedId = primitiveIds[0];
	const extraIds = primitiveIds.slice(1);
	let deletionAttempted = false;
	let deletionError: unknown;
	let nativeDeleteResultUnknown = false;
	let postDeleteReadbackFailed = false;
	const readCurrentIds = async (): Promise<string[]> => {
		await assertPlaceSessionPage(session.pageUuid);
		const ids = await Promise.resolve(api.getAllPrimitiveId.call(api.context, undefined, false));
		await assertPlaceSessionPage(session.pageUuid);
		if (!Array.isArray(ids))
			throw new TypeError('EDA 未返回当前器件 ID 列表。');
		return ids;
	};
	for (const id of extraIds) {
		let stage: 'delete' | 'readback' = 'delete';
		try {
			await assertPlaceSessionPage(session.pageUuid);
			deletionAttempted = true;
			await Promise.resolve(api.delete.call(api.context, id));
			stage = 'readback';
			let currentIds = await readCurrentIds();
			if (currentIds.includes(id)) {
				// Some EDA versions accept an ID but only delete the live primitive object.
				await assertPlaceSessionPage(session.pageUuid);
				const livePrimitives = await Promise.resolve(api.getAll.call(api.context, undefined, false));
				await assertPlaceSessionPage(session.pageUuid);
				if (!Array.isArray(livePrimitives))
					throw new TypeError('EDA 未返回当前器件列表。');
				const livePrimitive = livePrimitives.find(item => getSyncState(item, 'getState_PrimitiveId', '') === id);
				if (!livePrimitive || typeof livePrimitive !== 'object')
					throw new Error(`无法读取仍存在的重复器件 ${id}。`);
				stage = 'delete';
				await Promise.resolve(api.delete.call(api.context, livePrimitive));
				stage = 'readback';
				currentIds = await readCurrentIds();
			}
			if (currentIds.includes(id)) {
				deletionError = new Error(`重复器件 ${id} 在两种删除方式后仍存在。`);
				break;
			}
		}
		catch (error: unknown) {
			deletionError = error;
			if (stage === 'readback')
				postDeleteReadbackFailed = true;
			else
				nativeDeleteResultUnknown = isUnknownPlacementStartResult(toSafeErrorMessage(error));
			break;
		}
	}
	try {
		const currentIds = await readCurrentIds();
		const remainingIds = currentIds.filter(id => id && !session.referenceIds.has(id));
		if (nativeDeleteResultUnknown) {
			return {
				primitiveIds: remainingIds,
				warning: `重复器件删除结果未知，原生删除可能仍在执行：${toSafeErrorMessage(deletionError)}`,
				commitUnknown: true,
				nativeCallSettled: false,
			};
		}
		if (postDeleteReadbackFailed) {
			return {
				primitiveIds: remainingIds,
				warning: `重复器件删除后的回读失败，删除结果未知：${toSafeErrorMessage(deletionError)}`,
				commitUnknown: true,
				nativeCallSettled: true,
			};
		}
		if (!deletionError && remainingIds.length === 1 && remainingIds[0] === retainedId)
			return { primitiveIds: remainingIds, removedDuplicateIds: extraIds };
		return {
			primitiveIds: remainingIds,
			warning: `重复器件清理后仍有 ${String(remainingIds.length)} 个新增图元，请核对当前原理图。${deletionError ? `删除失败：${toSafeErrorMessage(deletionError)}` : ''}`,
		};
	}
	catch (error: unknown) {
		return {
			primitiveIds,
			warning: `重复器件清理后的回读失败，删除结果未知：${toSafeErrorMessage(error)}`,
			...(deletionAttempted ? { commitUnknown: true, nativeCallSettled: !nativeDeleteResultUnknown } : {}),
		};
	}
}

function resolveFollowMouseTipApi(): FollowMouseTipApi | null {
	const edaGlobal = getEdaRuntime();
	if (!edaGlobal || typeof edaGlobal !== 'object') {
		return null;
	}

	const messageModule = (edaGlobal as { sys_Message?: unknown }).sys_Message;
	if (!isPlainObjectRecord(messageModule)
		|| typeof messageModule.showFollowMouseTip !== 'function'
		|| typeof messageModule.removeFollowMouseTip !== 'function') {
		return null;
	}

	return {
		context: messageModule,
		show: messageModule.showFollowMouseTip as (tip: string, msTimeout?: number) => Promise<void>,
		remove: messageModule.removeFollowMouseTip as (tip?: string) => Promise<void>,
	};
}

async function cleanupPlaceSession(sessionId: string): Promise<void> {
	const session = activePlaceSessions.get(sessionId);
	if (!session) {
		return;
	}

	activePlaceSessions.delete(sessionId);
	// 移除 Esc 和右键退出监听器。
	if (session.cancelHandler) {
		const docRef = (globalThis as unknown as { document?: Document }).document;
		if (docRef) {
			docRef.removeEventListener('mouseup', session.cancelHandler, { capture: true });
			if (session.escapeHandler) {
				docRef.removeEventListener('keyup', session.escapeHandler, { capture: true });
			}
		}
		session.cancelHandler = null;
		session.escapeHandler = null;
	}
	if (session.followMouseTipApi) {
		try {
			await session.followMouseTipApi.remove.call(session.followMouseTipApi.context, session.tipText);
		}
		catch {
			// 清理提示失败时不影响主流程。
		}
	}
}

/** Clear interactive placement sessions when a Bridge connection is lost or replaced. */
export async function cleanupAllComponentPlaceSessions(): Promise<void> {
	placeSessionGeneration += 1;
	if ([...activePlaceSessions.values()].some(session => !session.placementExited)) {
		requirePlacementModeExit();
	}
	for (const sessionId of [...activePlaceSessions.keys()]) {
		await cleanupPlaceSession(sessionId);
	}
}

/**
 * 处理器件放置任务。
 * @param payload 任务参数。
 * @returns 交互放置任务描述。
 */
export async function handleComponentPlaceTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/place 任务参数必须为对象。');
	}

	const rawComponents = payload.components;
	if (!Array.isArray(rawComponents)) {
		throw new TypeError('缺少 components 参数，且其必须为数组。');
	}
	if (rawComponents.length < 1) {
		throw new Error('components 不能为空，至少需要提供一个待放置器件。');
	}
	if (rawComponents.length > 50) {
		throw new Error('components 数量过多，单次最多允许 50 个器件。');
	}

	const timeoutSeconds = resolveTimeoutSeconds(payload.timeoutSeconds);
	const components = rawComponents.map((item: unknown, index: number) => normalizeComponentPlaceItem(item, index));

	const placement: ComponentPlaceRequest = {
		protocol: COMPONENT_PLACE_PROTOCOL,
		title: '原理图器件放置',
		description: `请按顺序在原理图中放置以下 ${String(components.length)} 个器件。每次点击后按 Esc 或右键结束当前器件放置；超时后先核对图元，勿直接重试。`,
		components,
		timeoutSeconds,
	};

	return {
		ok: true,
		placement,
		message: `已创建 ${String(components.length)} 个器件的交互放置任务。`,
	};
}

/**
 * 启动单个器件的交互放置会话。
 * @param payload 单个器件放置参数。
 * @returns 放置会话标识。
 */
export async function handleComponentPlaceStartTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/place/start 任务参数必须为对象。');
	}
	if (placementModeNeedsExit) {
		return { ok: false, error: '上一次连接中断后，可能仍处于 EDA 器件放置模式；请先按 Esc 或右键退出，再重新放置。' };
	}
	if (activePlaceSessions.size > 0) {
		return { ok: false, error: '已有器件放置会话正在进行；请先结束当前放置。' };
	}
	const startGeneration = placeSessionGeneration;

	const component = normalizeComponentPlaceItem(payload.component, 0);

	const timeoutSeconds = resolveTimeoutSeconds(payload.timeoutSeconds);
	const timeoutMs = timeoutSeconds * 1000;
	const placeApi = resolvePlaceComponentApi();
	const followMouseTipApi = resolveFollowMouseTipApi();
	const tipText = `请在原理图中放置器件：${formatComponentTitle(component)}`;
	const pageUuid = await readCurrentSchematicPageUuid();
	// 必须先取基线，再把器件绑定到鼠标。用户可能在 API 返回后立即点击。
	const referenceIds = new Set(await Promise.resolve(placeApi.getAllPrimitiveId.call(placeApi.context, undefined, false)));
	const baselineDesignators = await readSchematicDesignators(placeApi);
	await assertPlaceSessionPage(pageUuid);
	if (placeSessionGeneration !== startGeneration || placementModeNeedsExit) {
		return { ok: false, error: '连接在准备器件放置时中断；请核对当前图页后再重试。' };
	}
	if (activePlaceSessions.size > 0) {
		return { ok: false, error: '已有器件放置会话正在进行；请先结束当前放置。' };
	}

	const sessionId = createPlaceSessionId();
	const session: ActivePlaceSession = {
		sessionId,
		component,
		pageUuid,
		referenceIds,
		baselineDesignators,
		tipText,
		followMouseTipApi,
		placeApi,
		createdAt: Date.now(),
		placementExited: false,
		cancelHandler: null,
		escapeHandler: null,
	};
	activePlaceSessions.set(sessionId, session);

	// 先监听退出动作，避免用户在 placeComponentWithMouse 返回前就完成点击和 Esc。
	const docRef = (globalThis as unknown as { document?: Document }).document;
	if (docRef) {
		session.cancelHandler = (event: Event): void => {
			if ((event as MouseEvent).button === 2) {
				session.placementExited = true;
			}
		};
		session.escapeHandler = (event: Event): void => {
			if ((event as KeyboardEvent).key === 'Escape') {
				session.placementExited = true;
			}
		};
		docRef.addEventListener('mouseup', session.cancelHandler, { capture: true });
		docRef.addEventListener('keyup', session.escapeHandler, { capture: true });
	}

	try {
		if (followMouseTipApi) {
			void Promise.resolve(followMouseTipApi.show.call(followMouseTipApi.context, tipText, timeoutMs)).catch(() => undefined);
		}
		const started = await Promise.resolve(placeApi.placeComponentWithMouse.call(
			placeApi.context,
			{ uuid: component.uuid, libraryUuid: component.libraryUuid },
			component.subPartName || undefined,
		));
		if (!started) {
			await cleanupPlaceSession(sessionId);
			return {
				ok: false,
				error: 'placeComponentWithMouse 返回 false，交互放置会话未能启动。',
			};
		}

		return {
			ok: true,
			sessionId,
		};
	}
	catch (error: unknown) {
		const errorMessage = toSafeErrorMessage(error);
		const commitUnknown = isUnknownPlacementStartResult(errorMessage);
		if (commitUnknown)
			requirePlacementModeExit();
		await cleanupPlaceSession(sessionId);

		return {
			ok: false,
			error: errorMessage,
			...(commitUnknown ? { commitUnknown: true, readbackRequired: true, nativeCallSettled: false } : {}),
		};
	}
}

/**
 * 轮询单个器件的交互放置状态。
 * @param payload 放置会话参数。
 * @returns 当前是否已完成放置。
 */
export async function handleComponentPlaceCheckTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/place/check 任务参数必须为对象。');
	}

	const sessionId = String(payload.sessionId ?? '').trim();
	if (sessionId.length === 0) {
		throw new Error('component/place/check 缺少 sessionId 参数。');
	}

	const session = activePlaceSessions.get(sessionId);
	if (!session) {
		return {
			ok: false,
			error: '未找到对应的器件放置会话。',
		};
	}

	try {
		await assertPlaceSessionPage(session.pageUuid);
		const currentIds = await Promise.resolve(session.placeApi.getAllPrimitiveId.call(session.placeApi.context, undefined, false));
		await assertPlaceSessionPage(session.pageUuid);
		const observedPrimitiveIds = currentIds.filter(id => id && !session.referenceIds.has(id));
		if (observedPrimitiveIds.length > 0) {
			if (!session.placementExited) {
				return {
					ok: true,
					placed: false,
					awaitingExit: true,
					candidatePrimitiveIds: observedPrimitiveIds,
					userCancelled: false,
				};
			}
			const cleanupResult = observedPrimitiveIds.length > 1
				? await cleanupExactPlacementDuplicates(session, observedPrimitiveIds)
				: { primitiveIds: observedPrimitiveIds };
			if ('commitUnknown' in cleanupResult && cleanupResult.commitUnknown) {
				await cleanupPlaceSession(sessionId);
				return {
					ok: false,
					commitUnknown: true,
					readbackRequired: true,
					nativeCallSettled: cleanupResult.nativeCallSettled,
					primitiveIds: observedPrimitiveIds,
					error: cleanupResult.warning,
				};
			}
			const primitiveIds = cleanupResult.primitiveIds;
			let designatorChanges: DesignatorChange[] = [];
			let restoredDesignators: DesignatorChange[] = [];
			let annotationWarning: string | undefined;
			try {
				const restored = await restoreChangedSchematicDesignators(
					session.placeApi,
					session.baselineDesignators,
					() => assertPlaceSessionPage(session.pageUuid),
				);
				designatorChanges = restored.designatorChanges;
				restoredDesignators = restored.restoredDesignators;
				annotationWarning = restored.annotationWarning;
				if (restored.commitUnknown) {
					await cleanupPlaceSession(sessionId);
					return {
						ok: false,
						commitUnknown: true,
						readbackRequired: true,
						nativeCallSettled: restored.nativeCallSettled,
						primitiveIds,
						designatorChanges,
						restoredDesignators,
						error: annotationWarning,
					};
				}
			}
			catch (error: unknown) {
				annotationWarning = `放置已执行，但无法核对已有器件位号：${toSafeErrorMessage(error)}`;
			}
			if ('warning' in cleanupResult && cleanupResult.warning)
				annotationWarning = [annotationWarning, cleanupResult.warning].filter(Boolean).join(' ');
			await assertPlaceSessionPage(session.pageUuid);
			await cleanupPlaceSession(sessionId);
			return {
				ok: true,
				placed: primitiveIds.length === 1 && !('warning' in cleanupResult && cleanupResult.warning),
				duplicate: primitiveIds.length > 1 || Boolean('warning' in cleanupResult && cleanupResult.warning),
				primitiveIds,
				...('removedDuplicateIds' in cleanupResult ? { removedDuplicateIds: cleanupResult.removedDuplicateIds } : {}),
				designatorChanges,
				restoredDesignators,
				annotationWarning,
				userCancelled: false,
			};
		}

		if (session.placementExited) {
			await cleanupPlaceSession(sessionId);
			return {
				ok: true,
				placed: false,
				userCancelled: true,
			};
		}

		return {
			ok: true,
			placed: false,
			userCancelled: false,
		};
	}
	catch (error: unknown) {
		return {
			ok: false,
			error: toSafeErrorMessage(error),
		};
	}
}

/**
 * 主动清理单个器件放置会话。
 * @param payload 放置会话参数。
 * @returns 清理结果。
 */
export async function handleComponentPlaceCloseTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/place/close 任务参数必须为对象。');
	}

	const sessionId = String(payload.sessionId ?? '').trim();
	if (sessionId.length === 0) {
		throw new Error('component/place/close 缺少 sessionId 参数。');
	}

	const session = activePlaceSessions.get(sessionId);
	if (session && !session.placementExited) {
		requirePlacementModeExit();
	}
	await cleanupPlaceSession(sessionId);
	return {
		ok: true,
	};
}
