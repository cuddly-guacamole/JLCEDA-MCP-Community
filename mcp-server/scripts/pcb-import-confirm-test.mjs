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

function respond(socket, clientId, transform) {
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    socket.send(JSON.stringify({ type: 'bridge/task-started', clientId, requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now() }));
    socket.send(JSON.stringify({ type: 'bridge/result', clientId, requestId: message.requestId, leaseTerm: message.leaseTerm, result: transform(message) }));
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
  const transform = message => {
    switch (message.path) {
      case '/bridge/jlceda/pcb/document':
        return message.payload?.action === 'import_changes'
          ? { ok: true, action: 'import_changes', commitState: 'pending_confirmation', importContext: { pageKind: 'pcb', pageUuid: 'pcb-one', documentUuid: 'document-one', projectUuid: 'project-one' } }
          : { ok: true, action: message.payload?.action ?? 'status' };
      case '/bridge/jlceda/context':
        return { currentDocumentInfo: { uuid: 'document-one', parentProjectUuid: 'project-one' }, currentPcbInfo: { uuid: pageUuid } };
      case '/bridge/jlceda/api/invoke':
        return { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'c1', x: 1, y: 2 }], componentCount: 1 };
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
  respond(oldSocket, 'import-original', transform);
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

  await server.request('/bridge/jlceda/pcb/document', { action: 'import_changes' }, 2000);
  netCount = 1001;
  netPages = 0;
  const secondSnapshot = await server.request('/bridge/admin/clients', {}, 2000);
  const secondRequestId = secondSnapshot.clients[0].quarantine.diagnostics.find(item => item.pendingNativeConfirmation).requestId;
  const recovery = await server.request('/bridge/admin/recover-client', { action: 'recover', confirm: true, requestId: secondRequestId }, 2000);
  oldSocket.close();
  await new Promise(resolve => oldSocket.once('close', resolve));
  freshSocket = await registerEda(port, 'import-fresh', 'import-test-token');
  respond(freshSocket, 'import-fresh', transform);
  const fallback = {
    action: 'readback', confirm: true, recoveryId: recovery.recoveryId, clientId: 'import-fresh',
    readbackPath: '/bridge/jlceda/api/invoke', readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  };
  await assert.rejects(server.request('/bridge/admin/recover-client', fallback, 2000), /original EDA host was restarted/);
  const recovered = await server.request('/bridge/admin/recover-client', { ...fallback, hostRestartConfirmed: true }, 2000);
  assert.equal(recovered.readbackVerified, true);
  assert.equal(netPages, 2);
  assert.equal((await server.request('/bridge/jlceda/pcb/document', { action: 'save' }, 2000)).ok, true);
  process.stdout.write('PCB import confirmation Server tests passed\n');
} finally {
  oldSocket?.close();
  freshSocket?.close();
  otherSocket?.close();
  server.close();
  if (originalToken === undefined) delete process.env.JLCEDA_BRIDGE_TOKEN;
  else process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
}
