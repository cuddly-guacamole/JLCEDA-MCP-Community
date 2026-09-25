import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { formatInternalClientEndpoint } from '../dist/mcp/bridge-client.js';
import { ToolDispatcher } from '../dist/mcp/tool-dispatcher.js';

const calls = [];
const fakeBridge = {
  async request(path, payload, timeoutMs) {
    calls.push({ path, payload, timeoutMs });
    if (path === '/bridge/jlceda/component/place') {
      return {
        ok: true,
        placement: {
          components: [{ uuid: 'device-1', libraryUuid: 'library-1', name: 'R1' }],
          timeoutSeconds: 30,
          retryCount: 1,
        },
      };
    }
    if (path === '/bridge/jlceda/component/place/start') {
      return { ok: true, sessionId: 'session-1' };
    }
    if (path === '/bridge/jlceda/component/place/check') {
      assert.equal(timeoutMs, undefined, 'placement check must use the Bridge server default budget for the 25s contract route');
      return { ok: true, placed: true, primitiveIds: ['placed-1'], designatorChanges: [{ primitiveId: 'old', before: 'U4', after: 'U15' }], annotationWarning: 'Designators changed', userCancelled: false };
    }
    if (path === '/bridge/jlceda/component/place/close') {
      return { ok: true };
    }
	if (path === '/bridge/jlceda/api/invoke' || path === '/bridge/jlceda/library/sources' || path === '/bridge/jlceda/workspace/query' || path === '/bridge/jlceda/design/source-export' || path === '/bridge/jlceda/net/query-pcb' || path === '/bridge/jlceda/pcb/constraints-manage' || path === '/bridge/jlceda/schematic/pages-manage') {
	  return { ok: true };
	}
	if (path === '/bridge/jlceda/library/preview') {
	  return { ok: true, kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'library-1', image: { kind: 'file', type: 'image/png', size: 4, dataBase64: 'AAAA', encoding: 'base64' } };
	}
    if (path === '/bridge/jlceda/canvas/snapshot') {
      return {
        ok: true,
        image: {
          type: 'image/png',
          encoding: 'base64',
          dataBase64: 'iVBORw0KGgoAAAANSUhEUg==',
          width: 640,
          height: 480,
          byteLength: 16,
        },
      };
    }
    if (path.startsWith('/bridge/jlceda/')) {
      return { ok: true };
    }
    throw new Error(`Unexpected path: ${path}`);
  },
};

const dispatcher = new ToolDispatcher(fakeBridge);
const result = await dispatcher.dispatch({
  name: 'component_place',
  arguments: {
    components: [{ uuid: 'device-1', libraryUuid: 'library-1', name: 'R1' }],
  },
});

assert.equal(result.structuredContent.ok, false);
assert.equal(result.structuredContent.placedCount, 1);
assert.deepEqual(result.structuredContent.results[0].primitiveIds, ['placed-1']);
assert.equal(result.structuredContent.results[0].annotationWarning, 'Designators changed');
assert.deepEqual(calls.map((call) => call.path), [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
]);

const duplicateCalls = [];
const duplicateBridge = {
  async request(path) {
    duplicateCalls.push(path);
    if (path === '/bridge/jlceda/component/place') {
      return { placement: { components: [{ uuid: 'one' }, { uuid: 'two' }], timeoutSeconds: 30, retryCount: 3 } };
    }
    if (path.endsWith('/start')) return { ok: true, sessionId: 'duplicate-session' };
    if (path.endsWith('/check')) return { ok: true, placed: false, duplicate: true, primitiveIds: ['a', 'b'] };
    if (path.endsWith('/close')) return { ok: true };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const duplicateResult = await new ToolDispatcher(duplicateBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(duplicateResult.structuredContent.ok, false);
assert.equal(duplicateResult.structuredContent.notAttemptedCount, 1);
assert.deepEqual(duplicateResult.structuredContent.results[0].primitiveIds, ['a', 'b']);
assert.deepEqual(duplicateCalls, [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
]);
assert.equal(calls.find(call => call.path === '/bridge/jlceda/component/place/start').payload.timeoutSeconds, 30,
  'the overall placement window must still be passed to the Bridge session');

const uncertainCleanupBridge = {
  async request(path) {
    if (path === '/bridge/jlceda/component/place')
      return { placement: { components: [{ uuid: 'one' }], timeoutSeconds: 30 } };
    if (path.endsWith('/start')) return { ok: true, sessionId: 'cleanup-session' };
    if (path.endsWith('/check')) return { ok: false, commitUnknown: true, readbackRequired: true, nativeCallSettled: false, primitiveIds: ['a', 'b'], designatorChanges: [{ primitiveId: 'old-u', before: 'U4', after: 'U15' }], restoredDesignators: [{ primitiveId: 'old-r', before: 'R8', after: 'R1' }], annotationWarning: 'Designators need review', error: 'duplicate cleanup readback failed' };
    if (path.endsWith('/close')) return { ok: true };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const uncertainCleanupResult = await new ToolDispatcher(uncertainCleanupBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(uncertainCleanupResult.structuredContent.ok, false);
assert.equal(uncertainCleanupResult.structuredContent.results[0].commitUnknown, true);
assert.equal(uncertainCleanupResult.structuredContent.results[0].readbackRequired, true);
assert.equal(uncertainCleanupResult.structuredContent.results[0].nativeCallSettled, false);
assert.deepEqual(uncertainCleanupResult.structuredContent.results[0].primitiveIds, ['a', 'b']);
assert.deepEqual(uncertainCleanupResult.structuredContent.results[0].designatorChanges, [{ primitiveId: 'old-u', before: 'U4', after: 'U15' }]);
assert.deepEqual(uncertainCleanupResult.structuredContent.results[0].restoredDesignators, [{ primitiveId: 'old-r', before: 'R8', after: 'R1' }]);
assert.equal(uncertainCleanupResult.structuredContent.results[0].annotationWarning, 'Designators need review');
assert.match(uncertainCleanupResult.structuredContent.results[0].error, /cleanup readback failed/);

const batchCalls = [];
let startedCount = 0;
let firstCheckCount = 0;
const batchBridge = {
  async request(path, payload) {
    batchCalls.push(path);
    if (path === '/bridge/jlceda/component/place') {
      return { placement: { components: [{ uuid: 'first' }, { uuid: 'second' }], timeoutSeconds: 30 } };
    }
    if (path.endsWith('/start')) return { ok: true, sessionId: `session-${++startedCount}` };
    if (path.endsWith('/check') && payload.sessionId === 'session-1') {
      firstCheckCount += 1;
      return firstCheckCount === 1
        ? { ok: true, placed: false, awaitingExit: true, candidatePrimitiveIds: ['floating-id'], userCancelled: false }
        : { ok: true, placed: true, primitiveIds: ['first-id'], removedDuplicateIds: ['first-extra'], restoredDesignators: [{ primitiveId: 'old-u', before: 'U15', after: 'U4' }], userCancelled: false };
    }
    if (path.endsWith('/check')) return { ok: true, placed: true, primitiveIds: ['second-id'], userCancelled: false };
    if (path.endsWith('/close')) return { ok: true };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const batchResult = await new ToolDispatcher(batchBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(batchResult.structuredContent.ok, true);
assert.deepEqual(batchResult.structuredContent.results.map((item) => item.primitiveIds), [['first-id'], ['second-id']]);
assert.deepEqual(batchResult.structuredContent.results[0].removedDuplicateIds, ['first-extra']);
assert.deepEqual(batchResult.structuredContent.results[0].restoredDesignators, [{ primitiveId: 'old-u', before: 'U15', after: 'U4' }]);
assert.equal(batchResult.structuredContent.results[0].candidatePrimitiveIds, undefined);
assert.deepEqual(batchCalls, [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
]);

const endpoint = formatInternalClientEndpoint(8765);
assert.equal(endpoint, 'ws://127.0.0.1:8765/mcp-internal');
assert.equal(endpoint.includes('token='), false);

const invokeResult = await dispatcher.dispatch({
  name: 'api_invoke',
  arguments: {
    apiFullName: 'eda.sch_Drc.check',
    timeoutMs: 42000,
  },
});
assert.equal(invokeResult.structuredContent.ok, true);
const invokeCall = calls.find(call => call.path === '/bridge/jlceda/api/invoke');
assert.equal(invokeCall.timeoutMs, 44000);

const snapshotTimeoutResult = await dispatcher.dispatch({
  name: 'eda_canvas_snapshot',
  arguments: { timeoutMs: 42000 },
});
assert.equal(snapshotTimeoutResult.structuredContent.ok, true);
const snapshotCall = calls.find(call => call.path === '/bridge/jlceda/canvas/snapshot');
assert.equal(snapshotCall.timeoutMs, 44000);

const sourcesResult = await dispatcher.dispatch({
  name: 'library_sources',
  arguments: { timeoutMs: 42000 },
});
assert.equal(sourcesResult.structuredContent.ok, true);
const sourcesCall = calls.find(call => call.path === '/bridge/jlceda/library/sources');
assert.equal(sourcesCall.timeoutMs, 44000);

const workspaceResult = await dispatcher.dispatch({
  name: 'workspace_query',
  arguments: { timeoutMs: 42000 },
});
assert.equal(workspaceResult.structuredContent.ok, true);
const workspaceCall = calls.find(call => call.path === '/bridge/jlceda/workspace/query');
assert.equal(workspaceCall.timeoutMs, 44000);

const sourceExportResult = await dispatcher.dispatch({
  name: 'design_source_export',
  arguments: { timeoutMs: 42000 },
});
assert.equal(sourceExportResult.structuredContent.ok, true);
const sourceExportCall = calls.find(call => call.path === '/bridge/jlceda/design/source-export');
assert.equal(sourceExportCall.timeoutMs, 44000);

const pcbNetQueryResult = await dispatcher.dispatch({
  name: 'pcb_net_query',
  arguments: { query: 'USB_D+', mode: 'exact', timeoutMs: 42000 },
});
assert.equal(pcbNetQueryResult.structuredContent.ok, true);
const pcbNetQueryCall = calls.find(call => call.path === '/bridge/jlceda/net/query-pcb');
assert.equal(pcbNetQueryCall.timeoutMs, 44000);

const pcbConnectivityPayload = { action: 'line_create', net: 'VCC', layer: 1,
  startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 0.2, timeoutMs: 42000 };
const pcbConnectivityResult = await dispatcher.dispatch({ name: 'pcb_connectivity_action', arguments: pcbConnectivityPayload });
assert.equal(pcbConnectivityResult.structuredContent.ok, true);
const pcbConnectivityCall = calls.find(call => call.path === '/bridge/jlceda/pcb/connectivity');
assert.deepEqual(pcbConnectivityCall.payload, pcbConnectivityPayload);
assert.equal(pcbConnectivityCall.timeoutMs, 44000);

for (const [name, timeoutMs] of [
  ['pcb_drc_check', 62_000],
  ['schematic_drc_check', 62_000],
  ['netlist_compare', 62_000],
  ['design_compare', 62_000],
  ['design_archive_export', 62_000],
  ['manufacture_export', 62_000],
  ['pcb_document_action', 62_000],
  ['pcb_connectivity_action', 32_000],
  ['schematic_document_action', 62_000],
  ['pcb_net_query', 62_000],
  ['design_source_export', 32_000],
  ['eda_canvas_snapshot', 32_000],
  ['library_sources', 32_000],
  ['library_classification_query', 32_000],
  ['library_preview', 32_000],
  ['workspace_query', 32_000],
  ['api_invoke', 17_000],
  ['eda_context', 17_000],
  ['component_select', 27_000],
]) {
  const callCount = calls.length;
  await dispatcher.dispatch({ name, arguments: {} });
  assert.equal(calls.length, callCount + 1, `${name} should dispatch exactly once`);
  assert.equal(calls.at(-1).timeoutMs, timeoutMs, `${name} should use its bridge default timeout plus transport grace`);
}

const constraintsManageResult = await dispatcher.dispatch({
	name: 'pcb_constraints_manage',
	arguments: { kind: 'net_class', operation: 'delete', name: 'obsolete', confirm: true },
});
assert.equal(constraintsManageResult.structuredContent.ok, true);
const constraintsManageCall = calls.find(call => call.path === '/bridge/jlceda/pcb/constraints-manage');
assert.equal(constraintsManageCall.payload.confirm, true);

const schematicPagesManageResult = await dispatcher.dispatch({
	name: 'schematic_pages_manage',
	arguments: { operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-2', 'page-1'], confirm: true },
});
assert.equal(schematicPagesManageResult.structuredContent.ok, true);
const schematicPagesManageCall = calls.find(call => call.path === '/bridge/jlceda/schematic/pages-manage');
assert.deepEqual(schematicPagesManageCall.payload.orderedPageUuids, ['page-2', 'page-1']);

const libraryPreviewResult = await dispatcher.dispatch({
  name: 'library_preview',
  arguments: { kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'library-1', timeoutMs: 42000 },
});
assert.deepEqual(libraryPreviewResult.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
assert.equal(libraryPreviewResult.structuredContent.image.dataBase64, undefined);
const libraryPreviewCall = calls.findLast(call => call.path === '/bridge/jlceda/library/preview');
assert.equal(libraryPreviewCall.timeoutMs, 44000);

const snapshotResult = await dispatcher.dispatch({
  name: 'eda_canvas_snapshot',
  arguments: {},
});
assert.equal(snapshotResult.content.length, 2);
assert.deepEqual(snapshotResult.content[0], {
  type: 'image',
  data: 'iVBORw0KGgoAAAANSUhEUg==',
  mimeType: 'image/png',
});
assert.equal(snapshotResult.content[1].type, 'text');
assert.deepEqual(JSON.parse(snapshotResult.content[1].text), {
  ok: true,
  image: {
    type: 'image/png',
    encoding: 'base64',
    width: 640,
    height: 480,
    byteLength: 16,
  },
});
assert.deepEqual(snapshotResult.structuredContent, {
	 ok: true,
	 image: {
		 type: 'image/png',
		 encoding: 'base64',
		 width: 640,
    height: 480,
    byteLength: 16,
  },
});

const definitions = JSON.parse(readFileSync(new URL('../dist/resources/mcp-tool-definitions.json', import.meta.url), 'utf8'));

function assertStrictParentDeclaresBranchProperties(schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }

  if (schema.additionalProperties === false) {
    const parentProperties = new Set(Object.keys(schema.properties ?? {}));
    for (const keyword of ['oneOf', 'anyOf']) {
      for (const [index, branch] of (schema[keyword] ?? []).entries()) {
        if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
          continue;
        }
        for (const property of Object.keys(branch.properties ?? {})) {
          assert.ok(
            parentProperties.has(property),
            `${path}.${keyword}[${index}].properties.${property} must also be declared by its strict parent`,
          );
        }
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' || typeof value !== 'object' || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        assertStrictParentDeclaresBranchProperties(child, `${path}.${key}[${index}]`);
      }
      continue;
    }
    assertStrictParentDeclaresBranchProperties(value, `${path}.${key}`);
  }
}

for (const definition of definitions) {
  assertStrictParentDeclaresBranchProperties(definition.inputSchema, `tool:${definition.name}.inputSchema`);
}

const workspaceDefinition = definitions.find((definition) => definition.name === 'workspace_query');
assert.ok(workspaceDefinition);
const workspaceSchema = z.fromJSONSchema(workspaceDefinition.inputSchema);
for (const input of [
  {},
  { action: 'teams' },
  { action: 'projects', teamUuid: 'team-1', folderUuid: 'folder-1', workspaceUuid: 'workspace-1' },
  { action: 'folders', teamUuid: 'team-1' },
]) {
  assert.equal(workspaceSchema.safeParse(input).success, true, `workspace_query should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'teams', folderUuid: 'folder-1' },
  { action: 'current', teamUuid: 'team-1' },
  { action: 'folders' },
  { action: 'folders', teamUuid: 'team-1', workspaceUuid: 'workspace-1' },
]) {
  assert.equal(workspaceSchema.safeParse(input).success, false, `workspace_query should reject ${JSON.stringify(input)}`);
}

const sourceExportDefinition = definitions.find((definition) => definition.name === 'design_source_export');
assert.ok(sourceExportDefinition);
const sourceExportSchema = z.fromJSONSchema(sourceExportDefinition.inputSchema);
assert.equal(sourceExportSchema.safeParse({}).success, true);
assert.equal(sourceExportSchema.safeParse({ action: 'footprints', limit: 1 }).success, true);
assert.equal(sourceExportSchema.safeParse({ action: 'document', limit: 1 }).success, false);

const pcbNetQueryDefinition = definitions.find((definition) => definition.name === 'pcb_net_query');
assert.ok(pcbNetQueryDefinition);
const pcbNetQuerySchema = z.fromJSONSchema(pcbNetQueryDefinition.inputSchema);
assert.equal(pcbNetQuerySchema.safeParse({ mode: 'all', timeoutMs: 6000 }).success, true);
assert.equal(pcbNetQuerySchema.safeParse({ mode: 'exact', query: 'USB_D+', timeoutMs: 6000 }).success, true);

const pcbConnectivityDefinition = definitions.find((definition) => definition.name === 'pcb_connectivity_action');
assert.ok(pcbConnectivityDefinition);
const pcbConnectivitySchema = z.fromJSONSchema(pcbConnectivityDefinition.inputSchema);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'line_create', net: 'VCC', layer: 1,
  startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 0.2 }).success, true);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'via_create', net: 'NEW_NET', allowNewNet: true,
  x: 10, y: 0, holeDiameter: 0.3, diameter: 0.6 }).success, true);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'line_create', net: 'VCC', layer: 1,
  startX: 0, startY: 0, endX: 10, endY: 0 }).success, false);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'via_create', net: 'VCC',
  x: 10, y: 0, holeDiameter: 0.3, diameter: 0.6, layer: 1 }).success, false);

const componentSelectDefinition = definitions.find((definition) => definition.name === 'component_select');
assert.ok(componentSelectDefinition);
const componentSelectSchema = z.fromJSONSchema(componentSelectDefinition.inputSchema);
assert.equal(componentSelectSchema.safeParse({ keyword: '1kΩ', limit: 2 }).success, true);
assert.equal(componentSelectSchema.safeParse({ properties: { supplierId: 'C25804' } }).success, true);
assert.equal(componentSelectSchema.safeParse({ keyword: '1kΩ', properties: { supplierId: 'C25804' } }).success, false);
assert.equal(componentSelectSchema.safeParse({ limit: 2 }).success, false);

const designCompareDefinition = definitions.find((definition) => definition.name === 'design_compare');
assert.ok(designCompareDefinition);
const designCompareSchema = z.fromJSONSchema(designCompareDefinition.inputSchema);
assert.equal(designCompareSchema.safeParse({ domain: 'netlist', sourceA: 'a', sourceB: 'b' }).success, true);
assert.equal(designCompareSchema.safeParse({ domain: 'schematic', sourceA: { projectUuid: 'project', schematicUuid: 'sch-a' }, sourceB: { projectUuid: 'project', schematicUuid: 'sch-b' } }).success, true);
assert.equal(designCompareSchema.safeParse({ domain: 'pcb', sourceA: { projectUuid: 'project', pcbUuid: 'pcb-a' }, sourceB: { projectUuid: 'project', pcbUuid: 'pcb-b' } }).success, true);
assert.equal(designCompareSchema.safeParse({ domain: 'netlist', sourceA: '', sourceB: 'b' }).success, false);

const schematicPagesDefinition = definitions.find((definition) => definition.name === 'schematic_pages_manage');
assert.ok(schematicPagesDefinition);
const schematicPagesSchema = z.fromJSONSchema(schematicPagesDefinition.inputSchema);
for (const input of [
	{ operation: 'create', schematicUuid: 'sch-1', confirm: true },
	{ operation: 'copy', sourcePageUuid: 'page-1', confirm: true },
	{ operation: 'copy', sourcePageUuid: 'page-1', schematicUuid: 'sch-2', confirm: true },
	{ operation: 'rename', schematicPageUuid: 'page-1', newName: 'Power', confirm: true },
	{ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-2', 'page-1'], confirm: true },
]) {
	assert.equal(schematicPagesSchema.safeParse(input).success, true, `schematic_pages_manage should accept ${JSON.stringify(input)}`);
}
for (const input of [
	{ operation: 'create', schematicUuid: 'sch-1', confirm: false },
	{ operation: 'copy', confirm: true },
	{ operation: 'rename', schematicPageUuid: 'page-1', confirm: true },
	{ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: [], confirm: true },
	{ operation: 'delete', schematicPageUuid: 'page-1', confirm: true },
]) {
	assert.equal(schematicPagesSchema.safeParse(input).success, false, `schematic_pages_manage should reject ${JSON.stringify(input)}`);
}

const librarySearchDefinition = definitions.find((definition) => definition.name === 'library_search');
assert.ok(librarySearchDefinition);
const librarySearchSchema = z.fromJSONSchema(librarySearchDefinition.inputSchema);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'Ngspice', limit: 3, page: 2 }).success, true);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'invalid' }).success, false);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', uuid: 'simulation-1' }).success, false);

const manufactureExportDefinition = definitions.find((definition) => definition.name === 'manufacture_export');
assert.ok(manufactureExportDefinition);
const manufactureExportSchema = z.fromJSONSchema(manufactureExportDefinition.inputSchema);
for (const input of [
  { domain: 'pcb', kind: 'gerber', unit: 'inch' },
  { domain: 'pcb', kind: 'pick_and_place', unit: 'mil' },
  { domain: 'pcb', kind: 'open_database', unit: 'inch' },
  { domain: 'pcb', kind: 'open_database', unit: 'mm' },
]) {
  assert.equal(manufactureExportSchema.safeParse(input).success, true, `manufacture_export should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { domain: 'pcb', kind: 'gerber', unit: 'mil' },
	{ domain: 'pcb', kind: 'gerber', unit: 'in' },
  { domain: 'pcb', kind: 'pick_and_place', unit: 'inch' },
	{ domain: 'pcb', kind: 'ipc_2581c' },
	{ domain: 'pcb', kind: 'jrouter_auto_route_json' },
  { domain: 'pcb', kind: 'bom', unit: 'mm' },
  { domain: 'schematic', kind: 'bom', unit: 'mm' },
]) {
  assert.equal(manufactureExportSchema.safeParse(input).success, false, `manufacture_export should reject ${JSON.stringify(input)}`);
}
assert.equal(manufactureExportSchema.safeParse({ domain: 'pcb', kind: 'pdf', template: 'ignored' }).success, false);
assert.equal(manufactureExportSchema.safeParse({ domain: 'schematic', kind: 'document', assemblyVariantsConfig: { text: 'x', value: 'y' } }).success, false);

const constraintsDefinition = definitions.find((definition) => definition.name === 'pcb_constraints_manage');
assert.ok(constraintsDefinition);
const constraintsSchema = z.fromJSONSchema(constraintsDefinition.inputSchema);
assert.equal(constraintsSchema.safeParse({ kind: 'net_class', operation: 'create', name: 'USB', nets: ['D+'], color: { r: 0, g: 0, b: 0, alpha: 1 }, confirm: true }).success, true);
assert.equal(constraintsSchema.safeParse({ kind: 'net_class', operation: 'create', name: 'USB', confirm: true }).success, false);
assert.equal(constraintsSchema.safeParse({ kind: 'differential_pair', operation: 'set_positive_net', name: 'USB', positiveNet: 'D+', confirm: true, nets: ['D+'] }).success, false);
assert.equal(constraintsSchema.safeParse({ kind: 'pad_pair_group', operation: 'add_members', name: 'USB', padPairs: [['J1.1', 'U1.1']], confirm: true }).success, true);

const schematicDocumentDefinition = definitions.find((definition) => definition.name === 'schematic_document_action');
assert.ok(schematicDocumentDefinition);
const schematicDocumentSchema = z.fromJSONSchema(schematicDocumentDefinition.inputSchema);
assert.equal(schematicDocumentSchema.safeParse({ action: 'primitive_at_point', x: 1, y: 2, ids: ['unexpected'] }).success, false);
assert.equal(schematicDocumentSchema.safeParse({ action: 'primitives_by_id', ids: ['primitive-1'], limit: 1 }).success, false);

const connectivityDefinition = definitions.find((definition) => definition.name === 'schematic_connectivity_action');
assert.ok(connectivityDefinition);
const connectivitySchema = z.fromJSONSchema(connectivityDefinition.inputSchema);
assert.equal(connectivitySchema.safeParse({ action: 'wire_preview', line: [0, 0, 100, 0] }).success, true);
assert.equal(connectivitySchema.safeParse({ action: 'wire_create', line: [0, 0, 100, 0], allowedWireIds: ['wire-1'] }).success, true);
const maximumWireLine = Array.from({ length: 256 }, (_, index) => [index, 0]).flat();
assert.equal(connectivityDefinition.inputSchema.properties.line.maxItems, 512);
for (const action of ['wire_preview', 'wire_create']) {
  const actionSchema = connectivityDefinition.inputSchema.oneOf.find((variant) => variant.properties.action.const === action);
  assert.equal(actionSchema.properties.line.maxItems, 512);
  assert.equal(connectivitySchema.safeParse({ action, line: maximumWireLine }).success, true);
  assert.equal(connectivitySchema.safeParse({ action, line: [...maximumWireLine, 256, 0] }).success, false);
}
assert.equal(connectivitySchema.safeParse({ action: 'netport_create', net: 'SIGNAL', x: 10, y: 20 }).success, true);
assert.equal(connectivitySchema.safeParse({ action: 'netport_move', id: 'port-1', x: 10, y: 20 }).success, true);
assert.equal(connectivitySchema.safeParse({ action: 'netport_move', id: 'port-1', x: 10 }).success, false);
assert.equal(connectivitySchema.safeParse({ action: 'wire_create', line: [0, 0, 100, 0], id: 'port-1' }).success, false);

const pcbDocumentDefinition = definitions.find((definition) => definition.name === 'pcb_document_action');
assert.ok(pcbDocumentDefinition);
const pcbDocumentSchema = z.fromJSONSchema(pcbDocumentDefinition.inputSchema);
assert.equal(pcbDocumentSchema.safeParse({ action: 'save' }).success, true);
assert.equal(pcbDocumentSchema.safeParse({ action: 'save', uuid: 'pcb-other' }).success, false);

await assert.rejects(
  dispatcher.dispatch({
    name: 'api_invoke',
    arguments: {
      apiFullName: 'eda.sch_Drc.check',
      timeoutMs: 999,
    },
  }),
  /timeoutMs must be an integer between 1000 and 120000/,
);

process.stdout.write('Tool dispatcher orchestration and log redaction tests passed\n');
