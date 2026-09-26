import { getEdaRuntime, isPlainObjectRecord, toSafeErrorMessage } from '../utils.ts';

type EdaApi = Record<string, unknown>;
type EdaMethod = (...args: unknown[]) => Promise<unknown>;

const INVENTORY_SYNC_DELAY_MS = 1_500;
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function api(runtime: EdaApi, name: string, methods: string[]): EdaApi {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable.`);
	return value;
}

async function call(target: EdaApi, method: string, ...args: unknown[]): Promise<unknown> {
	return await (target[method] as EdaMethod).call(target, ...args);
}

async function assertProject(projectApi: EdaApi, projectUuid: string): Promise<void> {
	const current = await call(projectApi, 'getCurrentProjectInfo');
	if (!isPlainObjectRecord(current) || current.uuid !== projectUuid)
		throw new Error('The active EDA project changed before Board setup.');
}

async function waitForInventorySync(): Promise<void> {
	// The official document-tree API examples wait for workspace inventory refresh.
	await new Promise<void>(resolve => globalThis.setTimeout(resolve, INVENTORY_SYNC_DELAY_MS));
}

function unknownWrite(error: unknown, nativeCallSettled: boolean, context: Record<string, unknown>): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!nativeCallSettled && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return {
		ok: false,
		...context,
		reason: nativeCallSettled ? 'post_write_readback_failed' : 'native_call_result_unknown',
		error: message,
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled,
	};
}

function documentInfo(value: unknown, kind: 'schematic' | 'pcb', projectUuid: string, boardName: string): { uuid: string; name: string; parentProjectUuid: string; parentBoardName: string } {
	if (!isPlainObjectRecord(value))
		throw new TypeError(`EDA ${kind} document is missing after Board creation.`);
	const uuid = requiredString(value.uuid, `EDA ${kind} uuid`);
	const name = requiredString(value.name, `EDA ${kind} name`);
	if (value.parentProjectUuid !== projectUuid || value.parentBoardName !== boardName)
		throw new Error(`EDA ${kind} document is not associated with the new Board in the current project.`);
	return { uuid, name, parentProjectUuid: projectUuid, parentBoardName: boardName };
}

export async function handleBoardSetupTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('board_setup payload must be an object.');
	if (payload.confirm !== true)
		throw new TypeError('confirm must be true before creating a Board.');
	const projectUuid = requiredString(payload.projectUuid, 'projectUuid');
	const schematicUuid = payload.schematicUuid === undefined ? undefined : requiredString(payload.schematicUuid, 'schematicUuid');
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const projectApi = api(runtime, 'dmt_Project', ['getCurrentProjectInfo']);
	const boardApi = api(runtime, 'dmt_Board', ['createBoard', 'getBoardInfo', 'getAllBoardsInfo']);
	const schematicApi = api(runtime, 'dmt_Schematic', ['getSchematicInfo']);
	const pcbApi = api(runtime, 'dmt_Pcb', ['getPcbInfo', 'getAllPcbsInfo', ...(schematicUuid ? ['createPcb'] : [])]);
	await assertProject(projectApi, projectUuid);

	if (schematicUuid) {
		const source = await call(schematicApi, 'getSchematicInfo', schematicUuid);
		if (!isPlainObjectRecord(source) || source.uuid !== schematicUuid || source.parentProjectUuid !== projectUuid)
			throw new TypeError('schematicUuid must identify a schematic in the current project.');
		if (typeof source.parentBoardName === 'string' && source.parentBoardName.trim())
			throw new TypeError('schematicUuid is already associated with a Board.');
	}

	const [beforeBoards, beforePcbs] = await Promise.all([
		call(boardApi, 'getAllBoardsInfo'),
		call(pcbApi, 'getAllPcbsInfo'),
	]);
	if (!Array.isArray(beforeBoards) || !Array.isArray(beforePcbs))
		throw new TypeError('EDA Board or PCB inventory is unavailable.');
	const beforeBoardNames = beforeBoards.filter(isPlainObjectRecord)
		.filter(board => board.parentProjectUuid === projectUuid)
		.map(board => board.name)
		.filter((name): name is string => typeof name === 'string');
	const beforePcbUuids = beforePcbs.filter(isPlainObjectRecord)
		.filter(pcb => pcb.parentProjectUuid === projectUuid)
		.map(pcb => pcb.uuid)
		.filter((uuid): uuid is string => typeof uuid === 'string');
	const context: Record<string, unknown> = { projectUuid, ...(schematicUuid ? { sourceSchematicUuid: schematicUuid } : {}), beforeBoardNames, beforePcbUuids };

	let createdPcbUuid: string | undefined;
	if (schematicUuid) {
		await assertProject(projectApi, projectUuid);
		let result: unknown;
		try {
			result = await call(pcbApi, 'createPcb');
		}
		catch (error: unknown) {
			return unknownWrite(error, false, { ...context, stage: 'create_pcb' });
		}
		if (typeof result !== 'string' || !result.trim())
			return { ok: false, ...context, stage: 'create_pcb', reason: 'native_rejected', changed: false };
		createdPcbUuid = result.trim();
		context.createdPcbUuid = createdPcbUuid;
		try {
			await waitForInventorySync();
			await assertProject(projectApi, projectUuid);
			const pcb = await call(pcbApi, 'getPcbInfo', createdPcbUuid);
			if (!isPlainObjectRecord(pcb) || beforePcbUuids.includes(createdPcbUuid)
				|| pcb.uuid !== createdPcbUuid || pcb.parentProjectUuid !== projectUuid
				|| (typeof pcb.parentBoardName === 'string' && pcb.parentBoardName.trim())) {
				throw new Error('Created PCB is not visible as an unassociated document in the current project.');
			}
		}
		catch (error: unknown) {
			return unknownWrite(error, true, { ...context, stage: 'verify_pcb' });
		}
	}

	try {
		await assertProject(projectApi, projectUuid);
	}
	catch (error: unknown) {
		if (!createdPcbUuid)
			throw error;
		return unknownWrite(error, true, { ...context, stage: 'verify_pcb' });
	}
	let result: unknown;
	try {
		result = await call(boardApi, 'createBoard', ...(schematicUuid ? [schematicUuid, createdPcbUuid] : []));
	}
	catch (error: unknown) {
		if (createdPcbUuid && !NATIVE_RESULT_UNKNOWN.test(toSafeErrorMessage(error))) {
			return {
				ok: false,
				...context,
				stage: 'create_board',
				reason: 'native_rejected',
				error: toSafeErrorMessage(error),
				changed: true,
				readbackRequired: true,
			};
		}
		return unknownWrite(error, false, { ...context, stage: 'create_board' });
	}
	if (typeof result !== 'string' || !result.trim()) {
		return {
			ok: false,
			...context,
			stage: 'create_board',
			reason: 'native_rejected',
			changed: Boolean(createdPcbUuid),
			readbackRequired: Boolean(createdPcbUuid),
		};
	}
	const boardName = result.trim();
	context.boardName = boardName;
	try {
		await waitForInventorySync();
		await assertProject(projectApi, projectUuid);
		const [rawBoard, rawBoards] = await Promise.all([
			call(boardApi, 'getBoardInfo', boardName),
			call(boardApi, 'getAllBoardsInfo'),
		]);
		if (!isPlainObjectRecord(rawBoard) || rawBoard.name !== boardName || rawBoard.parentProjectUuid !== projectUuid
			|| !Array.isArray(rawBoards) || beforeBoardNames.includes(boardName)
			|| !rawBoards.some(board => isPlainObjectRecord(board) && board.name === boardName && board.parentProjectUuid === projectUuid)) {
			throw new Error('New Board is absent from the current project inventory.');
		}
		const boardSchematicUuid = isPlainObjectRecord(rawBoard.schematic) ? requiredString(rawBoard.schematic.uuid, 'EDA Board schematic uuid') : '';
		const boardPcbUuid = isPlainObjectRecord(rawBoard.pcb) ? requiredString(rawBoard.pcb.uuid, 'EDA Board PCB uuid') : '';
		if (!boardSchematicUuid || !boardPcbUuid || (schematicUuid && boardSchematicUuid !== schematicUuid)
			|| (createdPcbUuid && boardPcbUuid !== createdPcbUuid)) {
			throw new Error('Board does not contain the expected schematic and PCB documents.');
		}
		const [rawSchematic, rawPcb] = await Promise.all([
			call(schematicApi, 'getSchematicInfo', boardSchematicUuid),
			call(pcbApi, 'getPcbInfo', boardPcbUuid),
		]);
		const schematic = documentInfo(rawSchematic, 'schematic', projectUuid, boardName);
		const pcb = documentInfo(rawPcb, 'pcb', projectUuid, boardName);
		await assertProject(projectApi, projectUuid);
		return {
			ok: true,
			projectUuid,
			boardName,
			schematicUuid: schematic.uuid,
			pcbUuid: pcb.uuid,
			...(createdPcbUuid ? { createdPcbUuid } : {}),
			board: { name: boardName, parentProjectUuid: projectUuid, schematicUuid: schematic.uuid, pcbUuid: pcb.uuid },
			schematic,
			pcb,
			verified: true,
		};
	}
	catch (error: unknown) {
		return unknownWrite(error, true, { ...context, stage: 'verify_board' });
	}
}
