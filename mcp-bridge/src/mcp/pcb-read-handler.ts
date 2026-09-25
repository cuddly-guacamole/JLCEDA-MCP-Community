import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSerializableAsync } from '../utils.ts';
import { handlePcbBoardOutlineManageTask } from './pcb-board-outline-manage-handler.ts';
import { handlePcbComponentEditTask } from './pcb-component-edit-handler.ts';
import { handlePcbPourManageTask } from './pcb-pour-manage-handler.ts';
import { handlePcbRegionManageTask } from './pcb-region-manage-handler.ts';
import { handlePcbRoutingEditTask } from './pcb-routing-edit-handler.ts';

type Section = 'components' | 'pads' | 'nets' | 'routing' | 'pours' | 'outline' | 'regions';

const SECTIONS: Section[] = ['components', 'pads', 'nets', 'routing', 'pours', 'outline', 'regions'];
const DEFAULT_SECTIONS: Section[] = ['components', 'nets'];

function requestedSections(payload: Record<string, unknown>): Section[] {
	const value = payload.sections;
	if (value === undefined)
		return DEFAULT_SECTIONS;
	if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string'))
		throw new TypeError('sections must be a non-empty array of PCB section names.');
	if (value.length === 1 && value[0] === 'all')
		return SECTIONS;
	if (value.some(item => !SECTIONS.includes(item as Section)) || new Set(value).size !== value.length)
		throw new TypeError(`sections must contain unique values from ${SECTIONS.join(', ')}, or only all.`);
	return SECTIONS.filter(section => value.includes(section));
}

function pcbApi(runtime: Record<string, unknown>, name: string, method: string): Record<string, unknown> {
	const api = runtime[name];
	if (!isPlainObjectRecord(api) || typeof api[method] !== 'function')
		throw new TypeError(`EDA ${name}.${method} is unavailable. Open a PCB document first.`);
	return api;
}

async function pageUuid(runtime: Record<string, unknown>): Promise<string> {
	const api = pcbApi(runtime, 'dmt_Pcb', 'getCurrentPcbInfo');
	const page = await (api.getCurrentPcbInfo as () => Promise<unknown>).call(api);
	if (!isPlainObjectRecord(page) || typeof page.uuid !== 'string' || !page.uuid.trim())
		throw new TypeError('EDA current PCB UUID is unavailable.');
	return page.uuid;
}

function state(raw: unknown, method: string): unknown {
	const getter = (raw as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB pad getter ${method} is unavailable.`);
	return getter.call(raw);
}

function padState(raw: unknown, source: 'standalone' | 'component'): Record<string, unknown> {
	const primitiveId = state(raw, 'getState_PrimitiveId');
	const layer = state(raw, 'getState_Layer');
	const padNumber = state(raw, 'getState_PadNumber');
	const x = state(raw, 'getState_X');
	const y = state(raw, 'getState_Y');
	const rotation = state(raw, 'getState_Rotation');
	const net = state(raw, 'getState_Net');
	const padType = state(raw, 'getState_PadType');
	if (typeof primitiveId !== 'string' || !primitiveId || typeof layer !== 'number' || !Number.isFinite(layer)
		|| typeof padNumber !== 'string' || typeof x !== 'number' || !Number.isFinite(x)
		|| typeof y !== 'number' || !Number.isFinite(y) || typeof rotation !== 'number' || !Number.isFinite(rotation)
		|| (net !== undefined && typeof net !== 'string') || typeof padType !== 'number' || !Number.isFinite(padType)) {
		throw new TypeError('EDA PCB pad identity, location, or network is not readable.');
	}
	const parentComponentPrimitiveId = source === 'component' ? state(raw, 'getState_ParentComponentPrimitiveId') : null;
	if (source === 'component' && (typeof parentComponentPrimitiveId !== 'string' || !parentComponentPrimitiveId))
		throw new TypeError('EDA component pad parent ID is not readable.');
	return { primitiveId, source, parentComponentPrimitiveId, layer, padNumber, x, y, rotation, net: net ?? null, padType };
}

async function readPads(runtime: Record<string, unknown>, componentIds?: string[]): Promise<Record<string, unknown>[]> {
	const standaloneApi = pcbApi(runtime, 'pcb_PrimitivePad', 'getAll');
	const componentApi = pcbApi(runtime, 'pcb_PrimitiveComponent', 'getAllPinsByPrimitiveId');
	if (!componentIds)
		pcbApi(runtime, 'pcb_PrimitiveComponent', 'getAllPrimitiveId');
	const [standalone, ids] = await Promise.all([
		(standaloneApi.getAll as () => Promise<unknown>).call(standaloneApi),
		componentIds ? Promise.resolve(componentIds) : (componentApi.getAllPrimitiveId as () => Promise<unknown>).call(componentApi),
	]);
	if (!Array.isArray(standalone) || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id))
		throw new TypeError('EDA PCB pad or component ID list is not readable.');
	const pads = new Map<string, Record<string, unknown>>();
	// pcb_PrimitivePad.getAll excludes ComponentPad in the current EDA client.
	for (const item of standalone) {
		const pad = padState(item, 'standalone');
		pads.set(pad.primitiveId as string, pad);
	}
	for (let offset = 0; offset < ids.length; offset += 8) {
		const batches = await Promise.all(ids.slice(offset, offset + 8).map(id =>
			(componentApi.getAllPinsByPrimitiveId as (id: string) => Promise<unknown>).call(componentApi, id as string)));
		for (const batch of batches) {
			if (!Array.isArray(batch))
				throw new TypeError('EDA component pad list is not readable.');
			for (const item of batch) {
				const pad = padState(item, 'component');
				pads.set(pad.primitiveId as string, pad);
			}
		}
	}
	return preserveBoundedArray([...pads.values()]);
}

async function readNets(runtime: Record<string, unknown>): Promise<unknown[]> {
	const api = pcbApi(runtime, 'pcb_Net', 'getAllNets');
	const raw = await (api.getAllNets as () => Promise<unknown>).call(api);
	if (!Array.isArray(raw) || raw.some(item => !isPlainObjectRecord(item) || typeof item.net !== 'string'))
		throw new TypeError('EDA PCB network details are not readable.');
	return preserveBoundedArray(await Promise.all(raw.map(item => toSerializableAsync(item))));
}

function sectionResult(value: unknown, section: Section, expectedPageUuid: string, arrays: string[]): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || value.ok !== true || value.complete !== true || value.pageUuid !== expectedPageUuid
		|| arrays.some(field => !Array.isArray(value[field]))) {
		throw new TypeError(`PCB ${section} read did not return a complete snapshot of the requested page.`);
	}
	return value;
}

export async function handlePcbReadTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('pcb_read payload must be an object.');
	const sections = requestedSections(isPlainObjectRecord(payload) ? payload : {});
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const expectedPageUuid = await pageUuid(runtime);
	const result: Record<string, unknown> = {
		ok: true,
		scope: 'current_pcb_page',
		pageUuid: expectedPageUuid,
		complete: true,
		includedSections: sections,
		omittedSections: SECTIONS.filter(section => !sections.includes(section)),
	};
	let componentIds: string[] | undefined;
	for (const section of sections) {
		if (section === 'components') {
			const read = sectionResult(await handlePcbComponentEditTask({ action: 'read' }), section, expectedPageUuid, ['components']);
			result.components = read.components;
			result.componentCount = (read.components as unknown[]).length;
			componentIds = (read.components as Array<Record<string, unknown>>).map(component => component.primitiveId as string);
		}
		else if (section === 'pads') {
			const pads = await readPads(runtime, componentIds);
			result.pads = pads;
			result.padCount = pads.length;
		}
		else if (section === 'nets') {
			const nets = await readNets(runtime);
			result.nets = nets;
			result.netCount = nets.length;
		}
		else if (section === 'routing') {
			const read = sectionResult(await handlePcbRoutingEditTask({ action: 'read' }), section, expectedPageUuid, ['lines', 'arcs', 'polylines', 'vias']);
			for (const field of ['lines', 'arcs', 'polylines', 'vias']) {
				result[field] = read[field];
				result[`${field.slice(0, -1)}Count`] = (read[field] as unknown[]).length;
			}
		}
		else if (section === 'pours') {
			const read = sectionResult(await handlePcbPourManageTask({ action: 'read' }), section, expectedPageUuid, ['pours', 'poured']);
			result.pours = read.pours;
			result.pourCount = (read.pours as unknown[]).length;
			result.poured = read.poured;
			result.pouredCount = (read.poured as unknown[]).length;
		}
		else if (section === 'outline') {
			const read = sectionResult(await handlePcbBoardOutlineManageTask({ action: 'read' }), section, expectedPageUuid, ['lines', 'arcs', 'polylines']);
			for (const field of ['lines', 'arcs', 'polylines']) {
				const outputField = `outline${field[0].toUpperCase()}${field.slice(1)}`;
				result[outputField] = read[field];
				result[`${outputField.slice(0, -1)}Count`] = (read[field] as unknown[]).length;
			}
		}
		else {
			const read = sectionResult(await handlePcbRegionManageTask({ action: 'read' }), section, expectedPageUuid, ['regions']);
			result.regions = read.regions;
			result.regionCount = (read.regions as unknown[]).length;
		}
		if (await pageUuid(runtime) !== expectedPageUuid)
			throw new Error('The active PCB changed during pcb_read. Retry on the intended page.');
	}
	return result;
}
