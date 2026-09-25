import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findPropertySchemas(schema, propertyName, matches = []) {
  if (!schema || typeof schema !== 'object') {
    return matches;
  }
  if (!Array.isArray(schema) && schema.properties?.[propertyName]) {
    matches.push(schema.properties[propertyName]);
  }
  for (const value of Object.values(schema)) {
    if (value && typeof value === 'object') {
      findPropertySchemas(value, propertyName, matches);
    }
  }
  return matches;
}

async function testProtocolVersion(protocolVersion) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: packageRoot,
    env: { ...process.env, JLCEDA_BRIDGE_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const lines = createInterface({ input: child.stdout });
    const modern = protocolVersion === '2026-07-28';
    const params = modern
      ? {
        _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'smoke-test', version: '1.0.0' },
        },
      }
      : {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0.0' },
      };
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: modern ? 'server/discover' : 'initialize',
      params,
    }) + '\n');

    const lineTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for initialize response')), 5000);
    });
    const [line] = await Promise.race([once(lines, 'line'), lineTimeout]);
    const response = JSON.parse(line);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    if (modern) {
      assert.ok(response.result?.resultType === 'complete', JSON.stringify(response));
      assert.equal(
        response.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name,
        'jlceda-mcp-server',
      );
    } else {
      assert.equal(response.result?.protocolVersion, protocolVersion);
      assert.equal(response.result?.serverInfo?.name, 'jlceda-mcp-server');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');
    }

    const toolsLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: modern ? params : {},
    }) + '\n');
    const [toolsLine] = await Promise.race([toolsLinePromise, lineTimeout]);
    const toolsResponse = JSON.parse(toolsLine);
    assert.equal(toolsResponse.id, 2);
    assert.ok(Array.isArray(toolsResponse.result?.tools));
    assert.ok(toolsResponse.result.tools.some((tool) => tool.name === 'eda_context'));
    assert.ok(toolsResponse.result.tools.some((tool) => tool.name === 'pcb_component_edit'));
    const recoverTool = toolsResponse.result.tools.find((tool) => tool.name === 'bridge_recover_client');
    assert.ok(recoverTool?.inputSchema, 'bridge_recover_client must publish an input schema');
    const confirmSchemas = findPropertySchemas(recoverTool.inputSchema, 'confirm');
    assert.ok(confirmSchemas.some((schema) => schema.const === true), 'bridge_recover_client must require confirm=true');
    const readbackPayloadSchemas = findPropertySchemas(recoverTool.inputSchema, 'readbackPayload');
    assert.ok(readbackPayloadSchemas.some((schema) => JSON.stringify(schema.default) === '{}'), 'bridge_recover_client must publish the empty readbackPayload default');
    const readbackPathSchemas = findPropertySchemas(recoverTool.inputSchema, 'readbackPath');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/api/invoke')), 'bridge_recover_client must allow current-page API readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/schematic/component-edit')), 'bridge_recover_client must publish schematic component state readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/component-edit')), 'bridge_recover_client must publish PCB component state readback');
    const expectedPageSchemas = findPropertySchemas(recoverTool.inputSchema, 'expectedPageUuid');
    assert.ok(expectedPageSchemas.some((schema) => schema.type === 'string'), 'bridge_recover_client must publish the optional page UUID');
    const actionSchemas = findPropertySchemas(recoverTool.inputSchema, 'action');
    assert.ok(actionSchemas.some((schema) => schema.const === 'resolve_import'), 'bridge_recover_client must advertise explicit PCB import resolution');
    const resolutionSchemas = findPropertySchemas(recoverTool.inputSchema, 'resolution');
    assert.ok(resolutionSchemas.some((schema) => schema.enum?.includes('applied') && schema.enum?.includes('cancelled')), 'bridge_recover_client must advertise both native dialog outcomes');

    // Exercise the registered MCP parser, not just the repository JSON Schema.
    // With no active recovery session, the accepted input must reach the Bridge
    // recovery handler and return its normal missing-session error.
    const callLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'bridge_recover_client',
        arguments: { action: 'readback', confirm: true, recoveryId: 'smoke-recovery', clientId: 'smoke-client',
          readbackPath: '/bridge/jlceda/schematic/component-edit', readbackPayload: { action: 'read' } },
      },
    }) + '\n');
    const [callLine] = await Promise.race([callLinePromise, lineTimeout]);
    const callResponse = JSON.parse(callLine);
    assert.equal(callResponse.id, 3);
    assert.match(JSON.stringify(callResponse), /No Bridge recovery is awaiting readback/);

    const pcbCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'bridge_recover_client',
        arguments: { action: 'readback', confirm: true, recoveryId: 'smoke-pcb-recovery', clientId: 'smoke-pcb-client',
          readbackPath: '/bridge/jlceda/pcb/component-edit', readbackPayload: { action: 'read' } },
      },
    }) + '\n');
    const [pcbCallLine] = await Promise.race([pcbCallLinePromise, lineTimeout]);
    const pcbCallResponse = JSON.parse(pcbCallLine);
    assert.equal(pcbCallResponse.id, 4);
    assert.match(JSON.stringify(pcbCallResponse), /No Bridge recovery is awaiting readback/);

    const invalidCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'pcb_component_edit',
        arguments: { action: 'modify', primitiveId: 'p1', property: {} },
      },
    }) + '\n');
    const [invalidCallLine] = await Promise.race([invalidCallLinePromise, lineTimeout]);
    const invalidCallResponse = JSON.parse(invalidCallLine);
    assert.equal(invalidCallResponse.id, 5);
    assert.match(JSON.stringify(invalidCallResponse), /property must contain at least one field/);

    child.stdin.end();
    const exitTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Server did not stop after stdin EOF')), 5000);
    });
    const [code] = await Promise.race([once(child, 'exit'), exitTimeout]);
    assert.equal(code, 0, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

await testProtocolVersion('2024-11-05');
await testProtocolVersion('2026-07-28');
process.stdout.write('MCP server legacy and modern protocol smoke tests passed\n');
