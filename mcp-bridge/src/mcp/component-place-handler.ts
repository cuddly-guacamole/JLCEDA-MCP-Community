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

import { getEdaRuntime, getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils';

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
}

interface FollowMouseTipApi {
	context: unknown;
	show: (tip: string, msTimeout?: number) => Promise<void>;
	remove: (tip?: string) => Promise<void>;
}

interface ActivePlaceSession {
	sessionId: string;
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
	};
}

async function readDesignators(api: PlaceComponentApi): Promise<Map<string, string>> {
	const components = await Promise.resolve(api.getAll.call(api.context, undefined, false));
	if (!Array.isArray(components)) {
		throw new TypeError('sch_PrimitiveComponent.getAll 未返回器件列表。');
	}
	const designators = new Map<string, string>();
	for (const component of components) {
		const id = getSyncState(component, 'getState_PrimitiveId', '');
		const designator = getSyncState(component, 'getState_Designator', '');
		if (id && designator) {
			designators.set(id, designator);
		}
	}
	return designators;
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
	const baselineDesignators = await readDesignators(placeApi);
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
		await cleanupPlaceSession(sessionId);

		return {
			ok: false,
			error: toSafeErrorMessage(error),
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
		const primitiveIds = currentIds.filter(id => id && !session.referenceIds.has(id));
		if (primitiveIds.length > 0) {
			if (!session.placementExited) {
				return {
					ok: true,
					placed: false,
					awaitingExit: true,
					candidatePrimitiveIds: primitiveIds,
					userCancelled: false,
				};
			}
			let designatorChanges: Array<{ primitiveId: string; before: string; after: string | undefined }> = [];
			let annotationWarning: string | undefined;
			try {
				const currentDesignators = await readDesignators(session.placeApi);
				designatorChanges = [...session.baselineDesignators]
					.filter(([id, before]) => currentDesignators.has(id) && currentDesignators.get(id) !== before)
					.map(([primitiveId, before]) => ({ primitiveId, before, after: currentDesignators.get(primitiveId) }));
				if (designatorChanges.length > 0) {
					annotationWarning = 'EDA 在放置时改变了已有器件位号；请核对 designatorChanges 后再继续。';
				}
			}
			catch (error: unknown) {
				annotationWarning = `放置已执行，但无法核对已有器件位号：${toSafeErrorMessage(error)}`;
			}
			await assertPlaceSessionPage(session.pageUuid);
			await cleanupPlaceSession(sessionId);
			return {
				ok: true,
				placed: primitiveIds.length === 1,
				duplicate: primitiveIds.length > 1,
				primitiveIds,
				designatorChanges,
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
