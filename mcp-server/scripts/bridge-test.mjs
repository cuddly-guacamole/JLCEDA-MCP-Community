import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { EdaBridgeServer } from '../dist/mcp/bridge-client.js';

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function expectPolicyClose(url) {
  const socket = new WebSocket(url);
  const [code] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for policy close')), 3000);
    socket.once('close', (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(code, 1008);
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

function attachTaskResponder(socket, clientId, transform) {
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') {
      return;
    }
    socket.send(JSON.stringify({
      type: 'bridge/task-started',
      clientId,
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      startedAt: Date.now(),
    }));
    socket.send(JSON.stringify({
      type: 'bridge/result',
      clientId,
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      result: transform(message),
    }));
  });
}

async function registerEda(url, clientId, context = undefined, sendInitialHeartbeat = true) {
  const socket = await connect(url);
  const welcome = waitForMessage(socket, (message) => message.type === 'bridge/welcome');
  const role = waitForMessage(socket, (message) => message.type === 'bridge/role');
  socket.send(JSON.stringify({ type: 'bridge/hello', clientId, bridgeVersion: '2.1.0', context }));
  const welcomeMessage = await welcome;
  assert.equal(welcomeMessage.clientId, clientId);
  assert.equal(welcomeMessage.protocolVersion, 1);
  const initialRole = await role;
  socket.send(JSON.stringify({ type: 'bridge/ready', clientId, readyAt: Date.now() }));
  if (sendInitialHeartbeat) {
    const heartbeat = waitForMessage(socket, (message) => message.type === 'bridge/heartbeat-ack');
    socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId, sentAt: Date.now() }));
    await heartbeat;
  }
  return { socket, initialRole };
}

const port = await reservePort();
const url = `ws://127.0.0.1:${port}`;
const originalToken = process.env.JLCEDA_BRIDGE_TOKEN;
process.env.JLCEDA_BRIDGE_TOKEN = 'bridge-test-token';
const tokenQuery = '?token=bridge-test-token';
const mainServer = new EdaBridgeServer(port);
const secondaryServer = new EdaBridgeServer(port);
let expiryServer;
let livenessServer;
let queueServer;
let recoveryServer;
let disconnectServer;
let edaFirstServer;
let queuedDisconnectServer;
let reconnectServer;
let blue;
let red;
let queued;
let stuck;
let replacement;
let wrongRecoveryPage;
let disconnectActive;
let disconnectReplacement;
let disconnectReconnected;
let edaFirstOld;
let edaFirstNew;
let queuedDisconnectOld;
let queuedDisconnectNew;
let reconnectOld;
let reconnectNew;
let reconnectTarget;
let disconnectedRecoveryServer;
let disconnectedRecoveryOld;
let disconnectedRecoveryTarget;

try {
  await mainServer.start();
  assert.equal(mainServer.getMode(), 'main');

  await expectPolicyClose(`${url}/bridge/ws`);
  await expectPolicyClose(`${url}/mcp-internal?token=wrong-token`);
  await expectPolicyClose(`${url}/unsupported${tokenQuery}`);

  blue = await registerEda(`${url}/bridge/ws${tokenQuery}`, 'blue-page');
  assert.equal(blue.initialRole.role, 'active');
  attachTaskResponder(blue.socket, 'blue-page', (message) => ({ source: 'blue', path: message.path }));
  assert.deepEqual(
    await mainServer.request('/bridge/test/blue', { value: 1 }, 2000),
    { source: 'blue', path: '/bridge/test/blue' },
  );

  red = await registerEda(`${url}/bridge/ws${tokenQuery}`, 'red-page');
  assert.equal(red.initialRole.role, 'standby');
  attachTaskResponder(red.socket, 'red-page', (message) => ({ source: 'red', path: message.path }));
  const clientsBeforeSelection = await mainServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(clientsBeforeSelection.activeClientId, 'blue-page');
  assert.deepEqual(clientsBeforeSelection.clients.map((client) => client.clientId), ['blue-page', 'red-page']);
  await mainServer.request('/bridge/admin/select-client', { clientId: 'red-page' }, 2000);
  assert.deepEqual(
    await mainServer.request('/bridge/test/selected-red', {}, 2000),
    { source: 'red', path: '/bridge/test/selected-red' },
  );
  const contextHeartbeat = waitForMessage(red.socket, (message) => message.type === 'bridge/heartbeat-ack');
  red.socket.send(JSON.stringify({
    type: 'bridge/heartbeat',
    clientId: 'red-page',
    sentAt: Date.now(),
    context: { projectUuid: 'project-2026', projectName: '2026', pageKind: 'schematic', pageUuid: 'red-sheet', pageName: 'RED HUB' },
  }));
  await contextHeartbeat;
  const clientsAfterHeartbeat = await mainServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(clientsAfterHeartbeat.clients[1].context.pageName, 'RED HUB');
  await assert.rejects(
    mainServer.request('/bridge/admin/select-client', { clientId: 'missing-page' }, 2000),
    /not connected and ready/,
  );
  await mainServer.request('/bridge/admin/select-client', { clientId: 'blue-page' }, 2000);
  const promoted = waitForMessage(
    red.socket,
    (message) => message.type === 'bridge/role' && message.role === 'active',
  );
  blue.socket.close();
  await promoted;
  assert.deepEqual(
    await mainServer.request('/bridge/test/red', { value: 2 }, 2000),
    { source: 'red', path: '/bridge/test/red' },
  );

  await secondaryServer.start();
  assert.equal(secondaryServer.getMode(), 'client');
  const sharedClients = await secondaryServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(sharedClients.activeClientId, 'red-page');
  assert.deepEqual(
    await secondaryServer.request('/bridge/jlceda/api/invoke', { value: 3 }, 2000),
    { source: 'red', path: '/bridge/jlceda/api/invoke' },
  );

  const forwardingPort = await reservePort();
  const forwardingMain = new EdaBridgeServer(forwardingPort);
  const forwardingSecondary = new EdaBridgeServer(forwardingPort);
  let forwardingEda;
  try {
    await forwardingMain.start();
    forwardingEda = await registerEda(
      `ws://127.0.0.1:${forwardingPort}/bridge/ws${tokenQuery}`,
      'forwarding-page',
    );
    await forwardingSecondary.start();
    assert.equal(forwardingSecondary.getMode(), 'client');

    let receivedFirstForwardedTask = false;
    let receivedSecondForwardedTask = false;
    let firstForwardedRequest;
    let secondForwardedRequest;
    let forwardedTaskCount = 0;
    forwardingEda.socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') {
        return;
      }
      const taskIndex = forwardedTaskCount;
      forwardedTaskCount += 1;
      if (taskIndex === 0) {
        firstForwardedRequest = message;
        receivedFirstForwardedTask = true;
        forwardingEda.socket.send(JSON.stringify({
          type: 'bridge/task-started',
          clientId: 'forwarding-page',
          requestId: message.requestId,
          leaseTerm: message.leaseTerm,
          startedAt: Date.now(),
        }));
        setTimeout(() => {
          forwardingEda.socket.send(JSON.stringify({
            type: 'bridge/result',
            clientId: 'forwarding-page',
            requestId: message.requestId,
            leaseTerm: message.leaseTerm,
            result: { task: 'first' },
          }));
          forwardingEda.socket.send(JSON.stringify({
            type: 'bridge/task-started',
            clientId: 'forwarding-page',
            requestId: secondForwardedRequest.requestId,
            leaseTerm: secondForwardedRequest.leaseTerm,
            startedAt: Date.now(),
          }));
          setTimeout(() => {
            forwardingEda.socket.send(JSON.stringify({
              type: 'bridge/result',
              clientId: 'forwarding-page',
              requestId: secondForwardedRequest.requestId,
              leaseTerm: secondForwardedRequest.leaseTerm,
              result: { task: 'second' },
            }));
          }, 15);
        }, 140);
        return;
      }
      if (taskIndex === 1) {
        secondForwardedRequest = message;
        receivedSecondForwardedTask = true;
        return;
      }
      forwardingEda.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'forwarding-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      setTimeout(() => {
        forwardingEda.socket.send(JSON.stringify({
          type: 'bridge/task-started',
          clientId: 'forwarding-page',
          requestId: message.requestId,
          leaseTerm: message.leaseTerm,
          startedAt: Date.now(),
        }));
      }, 20);
      if (taskIndex === 2) {
        setTimeout(() => {
          forwardingEda.socket.send(JSON.stringify({
            type: 'bridge/result',
            clientId: 'forwarding-page',
            requestId: message.requestId,
            leaseTerm: message.leaseTerm,
            result: { task: 'late-after-duplicate-started' },
          }));
        }, 60);
      }
    });

    const firstForwarded = forwardingMain.request('/bridge/jlceda/api/invoke', { marker: 'first' }, 500);
    await waitUntil(() => receivedFirstForwardedTask);
    const secondForwarded = forwardingSecondary.request('/bridge/jlceda/api/invoke', { marker: 'second' }, 50);
    let secondForwardedOutcome = 'pending';
    void secondForwarded.then(
      () => { secondForwardedOutcome = 'resolved'; },
      () => { secondForwardedOutcome = 'rejected'; },
    );
    await waitUntil(() => receivedSecondForwardedTask);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(secondForwardedOutcome, 'pending', 'client mode must not apply execution timeout while the main server queues the task');
    assert.deepEqual(await firstForwarded, { task: 'first' });
    assert.deepEqual(await secondForwarded, { task: 'second' });
    const duplicateStartedSocket = new WebSocket(`ws://127.0.0.1:${forwardingPort}/mcp-internal${tokenQuery}`);
    const duplicateStartedReady = waitForMessage(duplicateStartedSocket, (message) => message.type === 'bridge/internal-ready');
    await new Promise((resolve, reject) => {
      duplicateStartedSocket.once('open', resolve);
      duplicateStartedSocket.once('error', reject);
    });
    await duplicateStartedReady;
    const duplicateStartedResult = waitForMessage(
      duplicateStartedSocket,
      (message) => message.type === 'bridge/result' && message.requestId === 'duplicate-started-request',
    );
    duplicateStartedSocket.send(JSON.stringify({
      type: 'bridge/task',
      requestId: 'duplicate-started-request',
      path: '/bridge/jlceda/context',
      payload: { marker: 'duplicate-started' },
      timeoutMs: 50,
    }));
    assert.match(String((await duplicateStartedResult).error), /Request execution timeout after 50ms/);
    duplicateStartedSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(
      forwardingSecondary.request('/bridge/jlceda/context', { marker: 'started-without-result' }, 50),
      /(?:Internal bridge request execution timeout|Request execution timeout) after 50ms/,
    );
  } finally {
    forwardingEda?.socket.close();
    forwardingSecondary.close();
    forwardingMain.close();
  }

  const queuePort = await reservePort();
  queueServer = new EdaBridgeServer(queuePort);
  await queueServer.start();
  queued = await registerEda(
    `ws://127.0.0.1:${queuePort}/bridge/ws${tokenQuery}`,
    'queued-page',
  );
  let queuedTaskIndex = 0;
  queued.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') {
      return;
    }
    const taskIndex = queuedTaskIndex;
    queuedTaskIndex += 1;
    const queueDelayMs = taskIndex === 0 ? 0 : 100;
    setTimeout(() => {
      queued.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'queued-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      setTimeout(() => {
        queued.socket.send(JSON.stringify({
          type: 'bridge/result',
          clientId: 'queued-page',
          requestId: message.requestId,
          leaseTerm: message.leaseTerm,
          result: { taskIndex },
        }));
      }, 40);
    }, queueDelayMs);
  });
  const firstQueuedRequest = queueServer.request('/bridge/test/queued-1', {}, 80);
  const secondQueuedRequest = queueServer.request('/bridge/test/queued-2', {}, 80);
  assert.deepEqual(await firstQueuedRequest, { taskIndex: 0 });
  assert.deepEqual(await secondQueuedRequest, { taskIndex: 1 });
  queued.socket.close();
  queued = undefined;
  queueServer.close();
  queueServer = undefined;

  const recoveryPort = await reservePort();
  recoveryServer = new EdaBridgeServer(recoveryPort);
  await recoveryServer.start();
  stuck = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'stuck-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  let receivedStuckTask = false;
  stuck.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedStuckTask = true;
      stuck.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'stuck-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      setTimeout(() => {
        if (stuck.socket.readyState === WebSocket.OPEN) {
          stuck.socket.send(JSON.stringify({
            type: 'bridge/result',
            clientId: 'stuck-page',
            requestId: message.requestId,
            leaseTerm: message.leaseTerm,
            error: {
              message: `Bridge task timed out after 50ms: ${message.path}`,
              code: 'BRIDGE_TASK_TIMEOUT',
              timeoutMs: 50,
            },
          }));
        }
      }, 50);
    }
  });
  replacement = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'replacement-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  attachTaskResponder(replacement.socket, 'replacement-page', (message) => message.path === '/bridge/jlceda/context'
    ? { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' }, currentSchematicPageInfo: { uuid: 'recovery-page' } }
    : ({ source: 'replacement', path: message.path }));
  const stuckRequest = recoveryServer.request('/bridge/jlceda/schematic/layout-check', { mode: 'fix', confirm: true }, 100);
  await waitUntil(() => receivedStuckTask);
  await assert.rejects(
    recoveryServer.request('/bridge/admin/select-client', { clientId: 'replacement-page' }, 2000),
    /pending task/,
  );
  await assert.rejects(stuckRequest, /Bridge task timed out/);
  const recoverySnapshot = await recoveryServer.request('/bridge/admin/clients', {}, 2000);
  const recoveryRequestId = recoverySnapshot.clients
    .find((client) => client.clientId === 'stuck-page')
    .quarantine.diagnostics
    .find((diagnostic) => diagnostic.mutating)
    .requestId;
  const recoveryMessagePromise = waitForMessage(stuck.socket, (message) => message.type === 'bridge/recover');
  const recoveryStart = await recoveryServer.request('/bridge/admin/recover-client', { confirm: true, requestId: recoveryRequestId }, 2000);
  assert.equal(recoveryStart.readbackRequired, true);
  assert.match(recoveryStart.warning, /may have completed/);
  assert.equal(recoveryStart.diagnostic.mutating, true);
  assert.equal(recoveryStart.diagnostic.path, '/bridge/jlceda/schematic/layout-check');
  assert.equal(recoveryStart.diagnostic.timeoutMs, 50);
  const recoveryMessage = await recoveryMessagePromise;
  assert.equal(recoveryMessage.recoveryId, recoveryStart.recoveryId);
  stuck.socket.close();
  stuck = undefined;
  wrongRecoveryPage = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'wrong-recovery-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'another-page' },
  );
  await assert.rejects(recoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: recoveryStart.recoveryId,
    clientId: 'wrong-recovery-page',
    expectedPageUuid: 'another-page',
  }, 2000), /pageUuid does not match/);
  const freshRecoveryClient = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'recovered-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  let recoveryReadbackPageUuid = 'recovery-page';
  let failRecoveryReadback = false;
  attachTaskResponder(freshRecoveryClient.socket, 'recovered-page', (message) => {
    if (message.path === '/bridge/jlceda/context') {
      return { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' }, currentSchematicPageInfo: { uuid: recoveryReadbackPageUuid } };
    }
    if (failRecoveryReadback && message.path === '/bridge/jlceda/api/invoke') {
      return { ok: false, error: 'component readback failed' };
    }
    return { source: 'replacement', path: message.path };
  });
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/context', {}, 2000),
    { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' }, currentSchematicPageInfo: { uuid: 'recovery-page' } },
  );
  await assert.rejects(
    recoveryServer.request('/bridge/test/write-blocked', {}, 2000),
    /writes are blocked pending recovery readback/,
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, false] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  await assert.rejects(
    recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [1, false] }, 2000),
    /writes are blocked pending recovery readback/,
  );
  await assert.rejects(
    recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, true] }, 2000),
    /writes are blocked pending recovery readback/,
  );
  await assert.rejects(
    recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [1, false] }, 2000),
    /writes are blocked pending recovery readback/,
  );
  await assert.rejects(
    recoveryServer.request('/bridge/admin/recover-client', {
      action: 'readback',
      confirm: true,
      recoveryId: recoveryStart.recoveryId,
      clientId: 'recovered-page',
      expectedDocumentUuid: 'recovery-document',
      expectedProjectUuid: 'recovery-project',
      readbackPath: '/bridge/jlceda/schematic/layout-check',
      readbackPayload: { mode: 'fix', confirm: true },
    }, 2000),
    /read-only operation/,
  );
  const recoveryReadbackRequest = {
    action: 'readback',
    confirm: true,
    recoveryId: recoveryStart.recoveryId,
    clientId: 'recovered-page',
    expectedDocumentUuid: 'recovery-document',
    expectedProjectUuid: 'recovery-project',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] },
  };
  recoveryReadbackPageUuid = 'another-page';
  await assert.rejects(
    recoveryServer.request('/bridge/admin/recover-client', recoveryReadbackRequest, 2000),
    /Readback pageUuid does not match/,
  );
  await assert.rejects(recoveryServer.request('/bridge/test/write-still-blocked', {}, 2000), /writes are blocked pending recovery readback/);
  recoveryReadbackPageUuid = 'recovery-page';
  failRecoveryReadback = true;
  await assert.rejects(
    recoveryServer.request('/bridge/admin/recover-client', recoveryReadbackRequest, 2000),
    /Recovery readback failed: component readback failed/,
  );
  await assert.rejects(recoveryServer.request('/bridge/test/write-after-failed-readback', {}, 2000), /writes are blocked pending recovery readback/);
  failRecoveryReadback = false;
  const recoveryReadback = await recoveryServer.request('/bridge/admin/recover-client', recoveryReadbackRequest, 2000);
  assert.equal(recoveryReadback.readbackVerified, true);
  assert.equal(recoveryReadback.readback.path, '/bridge/jlceda/api/invoke');
  assert.deepEqual(
    await recoveryServer.request('/bridge/test/recovery-write-after-readback', {}, 2000),
    { source: 'replacement', path: '/bridge/test/recovery-write-after-readback' },
  );
  freshRecoveryClient.socket.close();
  wrongRecoveryPage.socket.close();
  wrongRecoveryPage = undefined;
  replacement.socket.close();
  replacement = undefined;
  recoveryServer.close();
  recoveryServer = undefined;

  const disconnectedRecoveryPort = await reservePort();
  disconnectedRecoveryServer = new EdaBridgeServer(disconnectedRecoveryPort);
  await disconnectedRecoveryServer.start();
  disconnectedRecoveryOld = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-old',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  disconnectedRecoveryOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      disconnectedRecoveryOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'disconnected-recovery-old',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
    }
  });
  disconnectedRecoveryTarget = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-target',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  attachTaskResponder(disconnectedRecoveryTarget.socket, 'disconnected-recovery-target', (message) => message.path === '/bridge/jlceda/context'
    ? { currentDocumentInfo: { uuid: 'disconnected-document', parentProjectUuid: 'disconnected-project' }, currentProjectInfo: { uuid: 'disconnected-project' }, currentPcbInfo: { uuid: 'disconnected-page' } }
    : ({ source: 'disconnected-recovery-target', path: message.path }));
  const disconnectedRequest = disconnectedRecoveryServer.request('/bridge/jlceda/api/invoke', {
    apiFullName: 'eda.pcb_Document.autoLayout', args: [],
  }, 100);
  await assert.rejects(disconnectedRequest, /Request execution timeout/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const disconnectedReadOnlyTimeout = disconnectedRecoveryServer.request('/bridge/jlceda/context', {}, 100);
  await assert.rejects(disconnectedReadOnlyTimeout, /Request execution timeout/);
  disconnectedRecoveryOld.socket.close();
  await waitUntil(async () => {
    const snapshot = await disconnectedRecoveryServer.request('/bridge/admin/clients', {}, 2000);
    return snapshot.activeClientId === 'disconnected-recovery-target';
  });
  const disconnectedSnapshot = await disconnectedRecoveryServer.request('/bridge/admin/clients', {}, 2000);
  const disconnectedDiagnostic = disconnectedSnapshot.clients
    .find((client) => client.clientId === 'disconnected-recovery-old')
    .quarantine.diagnostics
    .find((diagnostic) => diagnostic.mutating);
  assert.equal(disconnectedDiagnostic.requiredReadback, 'pcb_component_positions');
  const disconnectedRequestId = disconnectedDiagnostic.requestId;
  const disconnectedStart = await disconnectedRecoveryServer.request('/bridge/admin/recover-client', { confirm: true, requestId: disconnectedRequestId }, 2000);
  assert.equal(disconnectedStart.sourceConnected, false);
  assert.equal(disconnectedStart.freshBridgeGenerationRequested, false);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-target',
    expectedDocumentUuid: 'disconnected-document',
    expectedProjectUuid: 'disconnected-project',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  }, 2000), /not a fresh Bridge generation/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-blocked', {}, 2000), /writes are blocked pending recovery readback/);
  disconnectedRecoveryTarget.socket.close();
  disconnectedRecoveryTarget = undefined;
  disconnectedRecoveryOld = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-old',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  let pcbReadbackPageUuid = 'different-pcb';
  let pcbPositionReadbackValid = true;
  attachTaskResponder(disconnectedRecoveryOld.socket, 'disconnected-recovery-old', (message) => {
    if (message.path === '/bridge/jlceda/context') {
      return { currentDocumentInfo: { uuid: 'disconnected-document', parentProjectUuid: 'disconnected-project' }, currentProjectInfo: { uuid: 'disconnected-project' }, currentPcbInfo: { uuid: pcbReadbackPageUuid } };
    }
    if (message.path === '/bridge/jlceda/api/invoke') {
      return pcbPositionReadbackValid
        ? { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ primitiveId: 'pcb-component-1', designator: 'U1', x: 100, y: 200, rotation: 0 }], componentCount: 1 }
        : { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [], componentCount: 1 };
    }
    return { source: 'disconnected-recovery-old-reconnected', path: message.path };
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-old',
  }, 2000), /autoLayout requires eda.pcb_PrimitiveComponent.getAll/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-context-only', {}, 2000), /writes are blocked pending recovery readback/);
  const disconnectedReadbackRequest = {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-old',
    expectedDocumentUuid: 'disconnected-document',
    expectedProjectUuid: 'disconnected-project',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  };
  await assert.rejects(
    disconnectedRecoveryServer.request('/bridge/admin/recover-client', disconnectedReadbackRequest, 2000),
    /Readback pageUuid does not match/,
  );
  pcbReadbackPageUuid = 'disconnected-page';
  pcbPositionReadbackValid = false;
  await assert.rejects(
    disconnectedRecoveryServer.request('/bridge/admin/recover-client', disconnectedReadbackRequest, 2000),
    /did not return a complete component list/,
  );
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-incomplete-pcb-readback', {}, 2000), /writes are blocked pending recovery readback/);
  pcbPositionReadbackValid = true;
  const disconnectedReadback = await disconnectedRecoveryServer.request('/bridge/admin/recover-client', disconnectedReadbackRequest, 2000);
  assert.equal(disconnectedReadback.readbackVerified, true);
  assert.equal(disconnectedReadback.readback.componentCount, 1);
  disconnectedRecoveryOld.socket.close();
  disconnectedRecoveryOld = undefined;
  disconnectedRecoveryTarget = undefined;
  disconnectedRecoveryServer.close();
  disconnectedRecoveryServer = undefined;

  const disconnectPort = await reservePort();
  disconnectServer = new EdaBridgeServer(disconnectPort);
  await disconnectServer.start();
  disconnectActive = await registerEda(
    `ws://127.0.0.1:${disconnectPort}/bridge/ws${tokenQuery}`,
    'disconnect-active',
  );
  let receivedDisconnectedTask = false;
  disconnectActive.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedDisconnectedTask = true;
      disconnectActive.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'disconnect-active',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
    }
  });
  disconnectReplacement = await registerEda(
    `ws://127.0.0.1:${disconnectPort}/bridge/ws${tokenQuery}`,
    'disconnect-replacement',
  );
  attachTaskResponder(disconnectReplacement.socket, 'disconnect-replacement', (message) => ({
    source: 'disconnect-replacement',
    path: message.path,
  }));
  const mcpSocket = new WebSocket(`ws://127.0.0.1:${disconnectPort}/mcp-internal${tokenQuery}`);
  const mcpReady = waitForMessage(mcpSocket, (message) => message.type === 'bridge/internal-ready');
  await new Promise((resolve, reject) => {
    mcpSocket.once('open', resolve);
    mcpSocket.once('error', reject);
  });
  await mcpReady;
  const disconnectedTaskStarted = waitForMessage(mcpSocket, message => message.type === 'bridge/task-started' && message.requestId === 'disconnected-mcp-request');
  mcpSocket.send(JSON.stringify({
    type: 'bridge/task',
    requestId: 'disconnected-mcp-request',
    path: '/bridge/jlceda/api/invoke',
    payload: {},
    timeoutMs: 300,
  }));
  await waitUntil(() => receivedDisconnectedTask);
  await disconnectedTaskStarted;
  mcpSocket.close();
  await waitUntil(async () => {
    try {
      await disconnectServer.request('/bridge/admin/select-client', { clientId: 'disconnect-replacement' }, 2000);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(
    await disconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'disconnect-replacement', path: '/bridge/jlceda/context' },
  );
  disconnectReconnected = await registerEda(
    `ws://127.0.0.1:${disconnectPort}/bridge/ws${tokenQuery}`,
    'disconnect-active',
  );
  attachTaskResponder(disconnectReconnected.socket, 'disconnect-active', (message) => ({
    source: 'disconnect-reconnected',
    path: message.path,
  }));
  await disconnectServer.request('/bridge/admin/select-client', { clientId: 'disconnect-active' }, 2000);
  await assert.rejects(
    disconnectServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(disconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await disconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'disconnect-reconnected', path: '/bridge/jlceda/context' },
  );
  disconnectActive.socket.close();
  disconnectActive = undefined;
  disconnectReplacement.socket.close();
  disconnectReplacement = undefined;
  disconnectReconnected.socket.close();
  disconnectReconnected = undefined;
  disconnectServer.close();
  disconnectServer = undefined;

  const edaFirstPort = await reservePort();
  edaFirstServer = new EdaBridgeServer(edaFirstPort);
  await edaFirstServer.start();
  edaFirstOld = await registerEda(
    `ws://127.0.0.1:${edaFirstPort}/bridge/ws${tokenQuery}`,
    'eda-first-page',
  );
  let receivedEdaFirstTask = false;
  edaFirstOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedEdaFirstTask = true;
      edaFirstOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'eda-first-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
    }
  });
  const edaFirstPending = edaFirstServer.request('/bridge/jlceda/api/invoke', {}, 300);
  await waitUntil(() => receivedEdaFirstTask);
  edaFirstOld.socket.close();
  await assert.rejects(edaFirstPending, /disconnected/);
  await waitUntil(async () => {
    const snapshot = await edaFirstServer.request('/bridge/admin/clients', {}, 2000);
    return snapshot.clients.every(client => !client.ready);
  });
  const lostEdaDiagnostic = (await edaFirstServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
  assert.equal(lostEdaDiagnostic.mutating, true);
  assert.equal(lostEdaDiagnostic.uncertaintyReason, 'Active EDA client disconnected');
  edaFirstNew = await registerEda(
    `ws://127.0.0.1:${edaFirstPort}/bridge/ws${tokenQuery}`,
    'eda-first-page',
  );
  attachTaskResponder(edaFirstNew.socket, 'eda-first-page', (message) => ({
    source: 'eda-first-reconnected',
    path: message.path,
  }));
  await assert.rejects(
    edaFirstServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(edaFirstServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await edaFirstServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'eda-first-reconnected', path: '/bridge/jlceda/context' },
  );
  edaFirstOld = undefined;
  edaFirstNew.socket.close();
  edaFirstNew = undefined;
  edaFirstServer.close();
  edaFirstServer = undefined;

  const queuedDisconnectPort = await reservePort();
  queuedDisconnectServer = new EdaBridgeServer(queuedDisconnectPort);
  await queuedDisconnectServer.start();
  queuedDisconnectOld = await registerEda(
    `ws://127.0.0.1:${queuedDisconnectPort}/bridge/ws${tokenQuery}`,
    'queued-disconnect-page',
  );
  let queuedDisconnectTaskCount = 0;
  let queuedDisconnectFirstStarted = false;
  let queuedDisconnectSecondReceived = false;
  queuedDisconnectOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') {
      return;
    }
    const taskIndex = queuedDisconnectTaskCount;
    queuedDisconnectTaskCount += 1;
    if (taskIndex === 0) {
      queuedDisconnectFirstStarted = true;
      queuedDisconnectOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'queued-disconnect-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      return;
    }
    queuedDisconnectSecondReceived = true;
  });
  const queuedDisconnectFirst = queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 600);
  const queuedDisconnectSecond = queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 600);
  await waitUntil(() => queuedDisconnectFirstStarted && queuedDisconnectSecondReceived);
  queuedDisconnectOld.socket.close();
  await assert.rejects(queuedDisconnectFirst, /disconnected/);
  await assert.rejects(queuedDisconnectSecond, /disconnected/);
  await waitUntil(async () => {
    const snapshot = await queuedDisconnectServer.request('/bridge/admin/clients', {}, 2000);
    return snapshot.clients.every(client => !client.ready);
  });
  queuedDisconnectNew = await registerEda(
    `ws://127.0.0.1:${queuedDisconnectPort}/bridge/ws${tokenQuery}`,
    'queued-disconnect-page',
  );
  attachTaskResponder(queuedDisconnectNew.socket, 'queued-disconnect-page', (message) => ({
    source: 'queued-disconnect-reconnected',
    path: message.path,
  }));
  await assert.rejects(
    queuedDisconnectServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await queuedDisconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'queued-disconnect-reconnected', path: '/bridge/jlceda/context' },
  );
  queuedDisconnectOld = undefined;
  queuedDisconnectNew.socket.close();
  queuedDisconnectNew = undefined;
  queuedDisconnectServer.close();
  queuedDisconnectServer = undefined;

  const reconnectPort = await reservePort();
  reconnectServer = new EdaBridgeServer(reconnectPort);
  await reconnectServer.start();
  reconnectOld = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-page',
  );
  let receivedReconnectTask = false;
  reconnectOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedReconnectTask = true;
      reconnectOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'reconnect-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
    }
  });
  reconnectTarget = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-target',
  );
  attachTaskResponder(reconnectTarget.socket, 'reconnect-target', (message) => ({
    source: 'reconnect-target',
    path: message.path,
  }));
  const reconnectPending = reconnectServer.request('/bridge/jlceda/api/invoke', {}, 1000);
  const reconnectPendingAssertion = assert.rejects(reconnectPending, /reconnected/);
  await waitUntil(() => receivedReconnectTask);
  reconnectNew = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-page',
  );
  attachTaskResponder(reconnectNew.socket, 'reconnect-page', (message) => ({
    source: 'reconnect-page-new',
    path: message.path,
  }));
  await reconnectPendingAssertion;
  await reconnectServer.request('/bridge/admin/select-client', { clientId: 'reconnect-target' }, 2000);
  assert.deepEqual(
    await reconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'reconnect-target', path: '/bridge/jlceda/context' },
  );
  await reconnectServer.request('/bridge/admin/select-client', { clientId: 'reconnect-page' }, 2000);
  await assert.rejects(
    reconnectServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await assert.rejects(reconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await reconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'reconnect-page-new', path: '/bridge/jlceda/context' },
  );
  reconnectOld.socket.close();
  reconnectOld = undefined;
  reconnectNew.socket.close();
  reconnectNew = undefined;
  reconnectTarget.socket.close();
  reconnectTarget = undefined;
  reconnectServer.close();
  reconnectServer = undefined;

  const expiryPort = await reservePort();
  expiryServer = new EdaBridgeServer(expiryPort, { peerTtlMs: 250, peerSweepIntervalMs: 25 });
  await expiryServer.start();
  const stale = await registerEda(
    `ws://127.0.0.1:${expiryPort}/bridge/ws${tokenQuery}`,
    'stale-page',
  );
  const nonHeartbeatTraffic = setInterval(() => {
    if (stale.socket.readyState === WebSocket.OPEN)
      stale.socket.send(JSON.stringify({ type: 'bridge/ready', clientId: 'stale-page', readyAt: Date.now() }));
  }, 50);
  const [staleCloseCode] = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stale heartbeat peer did not close')), 2000);
    stale.socket.once('close', (...args) => {
      clearTimeout(timeout);
      resolve(args);
    });
  }).finally(() => clearInterval(nonHeartbeatTraffic));
  assert.equal(staleCloseCode, 4000);
  expiryServer.close();
  expiryServer = undefined;

  const livenessPort = await reservePort();
  livenessServer = new EdaBridgeServer(livenessPort, { peerTtlMs: 400, peerSweepIntervalMs: 1000 });
  await livenessServer.start();
  const livenessPeer = await registerEda(`ws://127.0.0.1:${livenessPort}/bridge/ws${tokenQuery}`, 'liveness-page', undefined, false);
  await waitUntil(async () => (await livenessServer.request('/bridge/admin/clients', {}, 2000)).clients[0].ready === true);
  const initialHeartbeat = waitForMessage(livenessPeer.socket, message => message.type === 'bridge/heartbeat-ack');
  livenessPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'liveness-page', sentAt: Date.now() }));
  await initialHeartbeat;
  await new Promise(resolve => setTimeout(resolve, 450));
  livenessPeer.socket.send(JSON.stringify({ type: 'bridge/ready', clientId: 'liveness-page', readyAt: Date.now() }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const staleHeartbeat = await livenessServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(staleHeartbeat.clients[0].ready, false, 'recent non-heartbeat traffic must not make a stale client ready');
  assert(staleHeartbeat.clients[0].lastHeartbeatMsAgo >= 400);
  await assert.rejects(
    livenessServer.request('/bridge/admin/select-client', { clientId: 'liveness-page' }, 2000),
    /not connected and ready/,
  );
  await assert.rejects(livenessServer.request('/bridge/jlceda/context', {}, 2000), /No ready EDA client connected/);
  const freshHeartbeat = waitForMessage(livenessPeer.socket, message => message.type === 'bridge/heartbeat-ack');
  livenessPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'liveness-page', sentAt: Date.now() }));
  await freshHeartbeat;
  assert.equal((await livenessServer.request('/bridge/admin/clients', {}, 2000)).clients[0].ready, true);
  livenessPeer.socket.close();
  livenessServer.close();
  livenessServer = undefined;

  mainServer.close();
  await waitUntil(() => secondaryServer.getMode() === 'main');
  red = await registerEda(`${url}/bridge/ws${tokenQuery}`, 'red-reconnected');
  attachTaskResponder(red.socket, 'red-reconnected', (message) => ({
    source: 'promoted-server',
    path: message.path,
  }));
  assert.deepEqual(
    await secondaryServer.request('/bridge/test/failover', { value: 4 }, 2000),
    { source: 'promoted-server', path: '/bridge/test/failover' },
  );

  process.stdout.write('Bridge protocol integration test passed\n');
} finally {
  blue?.socket.close();
  red?.socket.close();
  queued?.socket.close();
  stuck?.socket.close();
  replacement?.socket.close();
  wrongRecoveryPage?.socket.close();
  disconnectActive?.socket.close();
  disconnectReplacement?.socket.close();
  disconnectReconnected?.socket.close();
  edaFirstOld?.socket.close();
  edaFirstNew?.socket.close();
  queuedDisconnectOld?.socket.close();
  queuedDisconnectNew?.socket.close();
  reconnectOld?.socket.close();
  reconnectNew?.socket.close();
  reconnectTarget?.socket.close();
  disconnectedRecoveryOld?.socket.close();
  disconnectedRecoveryTarget?.socket.close();
  expiryServer?.close();
  livenessServer?.close();
  queueServer?.close();
  recoveryServer?.close();
  disconnectServer?.close();
  edaFirstServer?.close();
  queuedDisconnectServer?.close();
  reconnectServer?.close();
  disconnectedRecoveryServer?.close();
  secondaryServer.close();
  mainServer.close();
  if (originalToken === undefined) {
    delete process.env.JLCEDA_BRIDGE_TOKEN;
  } else {
    process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
  }
}
