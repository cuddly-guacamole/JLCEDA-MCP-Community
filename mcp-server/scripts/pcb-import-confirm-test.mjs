import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { EdaBridgeServer } from '../dist/mcp/bridge-client.js';

async function reservePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function registerEda(port, clientId, token, reportedPageUuid = 'pcb-one') {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws?token=${token}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const welcome = new Promise(resolve => {
    const onMessage = data => {
      if (JSON.parse(data.toString()).type === 'bridge/welcome') { socket.off('message', onMessage); resolve(); }
    };
    socket.on('message', onMessage);
  });
  const context = { documentUuid: 'document-one', projectUuid: 'project-one', pageKind: 'pcb', pageUuid: reportedPageUuid };
  socket.send(JSON.stringify({ type: 'bridge/hello', clientId, bridgeVersion: '2.3.2', context }));
  await welcome;
  socket.send(JSON.stringify({ type: 'bridge/ready', clientId, readyAt: Date.now() }));
  const heartbeatAck = new Promise(resolve => {
    const onMessage = data => {
      if (JSON.parse(data.toString()).type === 'bridge/heartbeat-ack') { socket.off('message', onMessage); resolve(); }
    };
    socket.on('message', onMessage);
  });
  socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId, sentAt: Date.now() }));
  await heartbeatAck;
  return socket;
}

function respond(socket, clientId, transform, options = {}) {
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    socket.send(JSON.stringify({ type: 'bridge/task-started', clientId, requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: options.executionContext?.() }));
    const resultMessage = { type: 'bridge/result', clientId, requestId: message.requestId, leaseTerm: message.leaseTerm, result: transform(message) };
    const delayMs = options.resultDelayMs?.(message) ?? 0;
    if (delayMs > 0) setTimeout(() => socket.send(JSON.stringify(resultMessage)), delayMs);
    else socket.send(JSON.stringify(resultMessage));
  });
}

const originalToken = process.env.JLCEDA_BRIDGE_TOKEN;
process.env.JLCEDA_BRIDGE_TOKEN = 'import-test-token';
const port = await reservePort();
const server = new EdaBridgeServer(port);
let oldSocket;
let freshSocket;
let otherSocket;
try {
  await server.start();
  let pageUuid = 'pcb-one';
  let truncateNets = false;
  let netCount = 1;
  let netPages = 0;
  let partialImportContext = false;
  let conflictingImportContext = false;
  let delayedImportResultMs = 0;
  const executionContext = () => ({ documentUuid: 'document-one', projectUuid: 'project-one', pageKind: 'pcb', pageUuid });
  const responseOptions = {
    executionContext,
    resultDelayMs: message => message.path === '/bridge/jlceda/pcb/document' && message.payload?.action === 'import_changes'
      ? delayedImportResultMs : 0,
  };
  const transform = message => {
    switch (message.path) {
      case '/bridge/jlceda/pcb/document':
        return message.payload?.action === 'import_changes'
          ? { ok: true, action: 'import_changes', commitState: 'pending_confirmation', importContext: conflictingImportContext
            ? { pageKind: 'pcb', pageUuid: 'pcb-one', documentUuid: 'document-one', projectUuid: 'other-project' }
            : partialImportContext ? { pageKind: 'pcb' }
              : { pageKind: 'pcb', pageUuid: 'pcb-one', documentUuid: 'document-one', projectUuid: 'project-one' } }
          : { ok: true, action: message.payload?.action ?? 'status' };
      case '/bridge/jlceda/context':
        return { currentDocumentInfo: { uuid: 'document-one', parentProjectUuid: 'project-one' }, currentPcbInfo: { uuid: pageUuid } };
      case '/bridge/jlceda/api/invoke':
        assert.equal(message.payload.includeCompletePositions, true);
        return { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'c1', x: 1, y: 2 }], componentPositions: [{ primitiveId: 'c1', designator: 'U1', x: 1, y: 2, rotation: 0 }], componentCount: 1 };
      case '/bridge/jlceda/net/query-pcb':
        netPages += 1;
        if (truncateNets) return { ok: true, mode: 'names', offset: 0, names: ['GND'], total: 2, returned: 1, truncated: false };
        {
          const offset = message.payload.offset ?? 0;
          const names = Array.from({ length: Math.min(1000, netCount - offset) }, (_, index) => `NET_${offset + index}`);
          return { ok: true, mode: 'names', offset, names, total: netCount, returned: names.length, truncated: offset + names.length < netCount };
        }
      case '/bridge/jlceda/pcb/import-resolve':
        return { ok: true, action: 'resolve_import', pageUuid: 'pcb-one' };
      default:
        return { ok: true, path: message.path };
    }
  };
  oldSocket = await registerEda(port, 'import-original', 'import-test-token', 'stale-previous-pcb');
  respond(oldSocket, 'import-original', transform, responseOptions);
  const importResult = await server.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 2000);
  assert.equal(importResult.commitState, 'pending_confirmation');
  const snapshot = await server.request('/bridge/admin/clients', {}, 2000);
  const requestId = snapshot.clients[0].quarantine.diagnostics.find(item => item.pendingNativeConfirmation).requestId;
  assert.equal(snapshot.clients[0].quarantine.diagnostics[0].context.pageUuid, 'pcb-one');
  await assert.rejects(server.request('/bridge/jlceda/pcb/document', { action: 'clear_routing' }, 2000), /writes are blocked/);
  assert.equal((await server.request('/bridge/jlceda/context', {}, 2000)).currentPcbInfo.uuid, 'pcb-one');
  assert.equal((await server.request('/bridge/jlceda/pcb/document', { action: 'status' }, 2000)).action, 'status');
  for (const payload of [
    { action: 'navigate_to_coordinates', x: 25, y: 35 },
    { action: 'navigate_to_region', left: 0, right: 100, top: 100, bottom: 0 },
    { action: 'zoom_to_board_outline' },
  ]) {
    assert.equal((await server.request('/bridge/jlceda/pcb/document', payload, 2000)).action, payload.action);
  }
  await assert.rejects(server.request('/bridge/jlceda/pcb/document', { action: 'select_primitives' }, 2000), /writes are blocked/);
  otherSocket = await registerEda(port, 'import-other', 'import-test-token', 'other-pcb');
  respond(otherSocket, 'import-other', transform);
  await server.request('/bridge/admin/select-client', { clientId: 'import-other' }, 2000);
  await assert.rejects(server.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000), /writes are blocked/);
  await server.request('/bridge/admin/select-client', { clientId: 'import-original' }, 2000);
  const resolvePayload = { action: 'resolve_import', confirm: true, requestId, resolution: 'applied' };
  pageUuid = 'pcb-other';
  await assert.rejects(server.request('/bridge/admin/recover-client', resolvePayload, 2000), /identity changed/);
  pageUuid = 'pcb-one';
  truncateNets = true;
  await assert.rejects(server.request('/bridge/admin/recover-client', resolvePayload, 2000), /net readback was incomplete/);
  await assert.rejects(server.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000), /writes are blocked/);
  truncateNets = false;
  const resolved = await server.request('/bridge/admin/recover-client', resolvePayload, 2000);
  assert.equal(resolved.readbackVerified, true);
  assert.equal(resolved.componentCount, 1);
  assert.equal(resolved.netCount, 1);
  assert.equal(resolved.writesRemainBlocked, false);
  assert.equal((await server.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000)).ok, true);

  partialImportContext = true;
  await server.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 2000);
  const partialSnapshot = await server.request('/bridge/admin/clients', {}, 2000);
  const partialDiagnostic = partialSnapshot.clients[0].quarantine.diagnostics.find(item => item.pendingNativeConfirmation);
  assert.deepEqual({ pageKind: partialDiagnostic.context.pageKind, pageUuid: partialDiagnostic.context.pageUuid,
    documentUuid: partialDiagnostic.context.documentUuid, projectUuid: partialDiagnostic.context.projectUuid }, executionContext());
  assert.equal((await server.request('/bridge/admin/recover-client', {
    action: 'resolve_import', confirm: true, requestId: partialDiagnostic.requestId, resolution: 'cancelled',
  }, 2000)).readbackVerified, true);

  delayedImportResultMs = 100;
  await assert.rejects(server.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 30), /execution timeout/);
  await new Promise(resolve => setTimeout(resolve, 140));
  const lateSnapshot = await server.request('/bridge/admin/clients', {}, 2000);
  const lateDiagnostic = lateSnapshot.clients[0].quarantine.diagnostics.find(item => item.pendingNativeConfirmation);
  assert.ok(lateDiagnostic);
  assert.deepEqual({ pageKind: lateDiagnostic.context.pageKind, pageUuid: lateDiagnostic.context.pageUuid,
    documentUuid: lateDiagnostic.context.documentUuid, projectUuid: lateDiagnostic.context.projectUuid }, executionContext());
  assert.equal((await server.request('/bridge/admin/recover-client', {
    action: 'resolve_import', confirm: true, requestId: lateDiagnostic.requestId, resolution: 'applied',
  }, 2000)).readbackVerified, true);
  delayedImportResultMs = 0;
  partialImportContext = false;

  await server.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 2000);
  netCount = 1001;
  netPages = 0;
  const secondSnapshot = await server.request('/bridge/admin/clients', {}, 2000);
  const secondRequestId = secondSnapshot.clients[0].quarantine.diagnostics.find(item => item.pendingNativeConfirmation).requestId;
  const recovery = await server.request('/bridge/admin/recover-client', { action: 'recover', confirm: true, requestId: secondRequestId }, 2000);
  oldSocket.close();
  await new Promise(resolve => oldSocket.once('close', resolve));
  freshSocket = await registerEda(port, 'import-fresh', 'import-test-token');
  respond(freshSocket, 'import-fresh', transform, responseOptions);
  const fallback = {
    action: 'readback', confirm: true, recoveryId: recovery.recoveryId, clientId: 'import-fresh',
    readbackPath: '/bridge/jlceda/api/invoke', readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  };
  await assert.rejects(server.request('/bridge/admin/recover-client', fallback, 2000), /original EDA host was restarted/);
  const recovered = await server.request('/bridge/admin/recover-client', { ...fallback, hostRestartConfirmed: true }, 2000);
  assert.equal(recovered.readbackVerified, true);
  assert.equal(netPages, 2);
  assert.equal((await server.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000)).ok, true);
  conflictingImportContext = true;
  await server.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 2000);
  const conflictSnapshot = await server.request('/bridge/admin/clients', {}, 2000);
  const conflictDiagnostic = conflictSnapshot.clients.find(item => item.clientId === 'import-fresh').quarantine.diagnostics.find(item => item.pendingNativeConfirmation);
  assert.equal(conflictDiagnostic.importContextConflict, true);
  assert.equal(conflictDiagnostic.context.projectUuid, 'project-one');
  await assert.rejects(server.request('/bridge/admin/recover-client', {
    action: 'resolve_import', confirm: true, requestId: conflictDiagnostic.requestId, resolution: 'applied',
  }, 2000), /identity disagrees/);
  await assert.rejects(server.request('/bridge/admin/recover-client', {
    action: 'recover', confirm: true, requestId: conflictDiagnostic.requestId,
  }, 2000), /identity disagrees/);
  await assert.rejects(server.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000), /writes are blocked/);
} finally {
  oldSocket?.close();
  freshSocket?.close();
  otherSocket?.close();
  server.close();
  if (originalToken === undefined) delete process.env.JLCEDA_BRIDGE_TOKEN;
  else process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
}

async function waitForLateImportResult(server, requestId, conflicting) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await server.request('/bridge/admin/clients', {}, 2000);
    const diagnostic = snapshot.clients.flatMap(client => client.quarantine?.diagnostics ?? [])
      .find(item => item.requestId === requestId);
    if (diagnostic?.pendingNativeConfirmation && (!conflicting || diagnostic.importContextConflict)) return diagnostic;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Late PCB import result was not recorded');
}

async function verifyLateImportAfterRecoveryStarted(duringReadback, conflicting = true) {
  const previousToken = process.env.JLCEDA_BRIDGE_TOKEN;
  process.env.JLCEDA_BRIDGE_TOKEN = 'import-race-token';
  const racePort = await reservePort();
  const raceServer = new EdaBridgeServer(racePort);
  let source;
  let sourceReconnect;
  let target;
  try {
    await raceServer.start();
    source = await registerEda(racePort, 'race-source', 'import-race-token');
    let importTask;
    source.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task' || message.path !== '/bridge/jlceda/pcb/document') return;
      importTask = message;
      source.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'race-source', requestId: message.requestId,
        leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { pageKind: 'pcb', pageUuid: 'pcb-one', documentUuid: 'document-one', projectUuid: 'project-one' } }));
    });
    await assert.rejects(raceServer.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 30), /execution timeout/);
    const snapshot = await raceServer.request('/bridge/admin/clients', {}, 2000);
    const requestId = snapshot.clients[0].quarantine.diagnostics[0].requestId;
    assert.equal(importTask.requestId, requestId);
    const recovery = await raceServer.request('/bridge/admin/recover-client', { action: 'recover', confirm: true, requestId }, 2000);
    const lateResult = { type: 'bridge/result', clientId: 'race-source', requestId,
      leaseTerm: importTask.leaseTerm, result: { ok: true, action: 'import_changes', commitState: 'pending_confirmation',
        importContext: { pageKind: 'pcb', pageUuid: 'pcb-one', documentUuid: 'document-one',
          projectUuid: conflicting ? 'other-project' : 'project-one' } } };
    const readbackPayload = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
      clientId: 'race-target', hostRestartConfirmed: true, readbackPath: '/bridge/jlceda/api/invoke',
      readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] } };
    if (!duringReadback) {
      source.send(JSON.stringify(lateResult));
      assert.equal((await waitForLateImportResult(raceServer, requestId, conflicting)).context.projectUuid, 'project-one');
      await assert.rejects(raceServer.request('/bridge/admin/recover-client', readbackPayload, 2000), /identity disagrees/);
    } else {
      source.close();
      await new Promise(resolve => source.once('close', resolve));
      target = await registerEda(racePort, 'race-target', 'import-race-token');
      let releaseReadback;
      let readbackStarted;
      let holdFirstReadback = true;
      let netReadbackCount = 0;
      const readbackDispatched = new Promise(resolve => { readbackStarted = resolve; });
      target.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        target.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'race-target', requestId: message.requestId,
          leaseTerm: message.leaseTerm, startedAt: Date.now() }));
        let result;
        if (message.path === '/bridge/jlceda/api/invoke') {
          result = { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'c1', x: 1, y: 2 }],
            componentPositions: [{ primitiveId: 'c1', designator: 'U1', x: 1, y: 2, rotation: 0 }], componentCount: 1 };
        } else if (message.path === '/bridge/jlceda/context') {
          result = { currentDocumentInfo: { uuid: 'document-one', parentProjectUuid: 'project-one' }, currentPcbInfo: { uuid: 'pcb-one' } };
        } else if (message.path === '/bridge/jlceda/net/query-pcb') {
          netReadbackCount += 1;
          result = { ok: true, mode: 'names', offset: 0, names: ['GND'], total: 1, returned: 1, truncated: false };
        } else throw new Error(`Unexpected recovery readback path: ${message.path}`);
        const reply = () => target.send(JSON.stringify({ type: 'bridge/result', clientId: 'race-target',
          requestId: message.requestId, leaseTerm: message.leaseTerm, result }));
        if (message.path === '/bridge/jlceda/api/invoke' && holdFirstReadback) {
          holdFirstReadback = false;
          releaseReadback = reply;
          readbackStarted();
        } else reply();
      });
      const readback = raceServer.request('/bridge/admin/recover-client', readbackPayload, 5000);
      await readbackDispatched;
      sourceReconnect = await registerEda(racePort, 'race-source', 'import-race-token');
      sourceReconnect.send(JSON.stringify(lateResult));
      assert.equal((await waitForLateImportResult(raceServer, requestId, conflicting)).context.projectUuid, 'project-one');
      releaseReadback();
      await assert.rejects(readback, conflicting ? /identity disagrees/ : /confirmation state changed/);
      if (!conflicting) {
        assert.equal(netReadbackCount, 1);
        const retry = await raceServer.request('/bridge/admin/recover-client', readbackPayload, 5000);
        assert.equal(retry.readbackVerified, true);
        assert.equal(retry.writesRemainBlocked, false);
        assert.equal(netReadbackCount, 2);
      }
    }
    if (conflicting)
      await assert.rejects(raceServer.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000), /writes are blocked/);
  } finally {
    source?.close();
    sourceReconnect?.close();
    target?.close();
    raceServer.close();
    if (previousToken === undefined) delete process.env.JLCEDA_BRIDGE_TOKEN;
    else process.env.JLCEDA_BRIDGE_TOKEN = previousToken;
  }
}

await verifyLateImportAfterRecoveryStarted(false);
await verifyLateImportAfterRecoveryStarted(true);
await verifyLateImportAfterRecoveryStarted(true, false);
process.stdout.write('PCB import confirmation Server tests passed\n');
