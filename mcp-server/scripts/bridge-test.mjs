import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { EdaBridgeServer } from '../dist/mcp/bridge-client.js';
import { isReadOnlyBridgeRequest, validateBridgeClientMessage } from '../dist/mcp/bridge-contract.js';

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
let connectivityServer;
let recoveryServer;
let disconnectServer;
let edaFirstServer;
let queuedDisconnectServer;
let reconnectServer;
let blue;
let red;
let queued;
let connectivityClient;
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
let disconnectedRecoveryFresh;
let nativeLayoutServer;
let nativeLayoutOld;
let nativeLayoutNew;
let lateUnknownServer;
let lateUnknownClient;
let lateConnectivityServer;
let lateConnectivityActive;
let lateConnectivityStandby;
let unverifiedWriteServer;
let unverifiedWriteActive;
let unverifiedWriteStandby;

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

  const connectivityPath = '/bridge/jlceda/schematic/connectivity';
  assert.equal(validateBridgeClientMessage({
    type: 'bridge/task-started', clientId: 'pcb-client', requestId: 'layout-1', leaseTerm: 1, startedAt: Date.now(),
    context: { pageKind: 'pcb', pageUuid: 'actual-pcb', documentUuid: 'actual-document' },
  }), undefined);
  for (const action of ['navigate_to_coordinates', 'navigate_to_region', 'zoom_to_board_outline']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/document', { action }), true);
  }
  for (const action of ['select_primitives', 'clear_selection', 'start_ratline', 'stop_ratline', 'save', 'import_changes']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/document', { action }), false);
  }
  for (const action of [undefined, 'status', 'selection', 'primitive_by_id', 'navigate_to_coordinates', 'navigate_to_region']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/document', action === undefined ? {} : { action }), true);
  }
  for (const action of ['select_primitives', 'clear_selection', 'save', 'import_changes']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/document', { action }), false);
  }
  assert.equal(isReadOnlyBridgeRequest(connectivityPath, { action: 'wire_preview' }), true);
  for (const action of ['wire_create', 'netport_create', 'netport_move']) {
    assert.equal(isReadOnlyBridgeRequest(connectivityPath, { action }), false);
  }
  assert.equal(isReadOnlyBridgeRequest(connectivityPath, {}), false);
  const invokePath = '/bridge/jlceda/api/invoke';
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: 'eda.pcb_primitivecomponent.getall', args: [] }), true);
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: ' EDA.SCH_PRIMITIVECOMPONENT.GETALL ', args: [null, false] }), true);
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: 'EDA.SCH_PRIMITIVECOMPONENT.GETALL', args: [null, true] }), false);
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: 'EDA.SCH_PRIMITIVECOMPONENT.CREATE', args: [] }), false);
  const connectivityPort = await reservePort();
  connectivityServer = new EdaBridgeServer(connectivityPort);
  await connectivityServer.start();
  connectivityClient = await registerEda(
    `ws://127.0.0.1:${connectivityPort}/bridge/ws${tokenQuery}`,
    'connectivity-page',
  );
  let previewTasksStarted = 0;
  connectivityClient.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    connectivityClient.socket.send(JSON.stringify({
      type: 'bridge/task-started',
      clientId: 'connectivity-page',
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      startedAt: Date.now(),
    }));
    if (message.payload.action === 'wire_preview') {
      previewTasksStarted += 1;
      return;
    }
    connectivityClient.socket.send(JSON.stringify({
      type: 'bridge/result',
      clientId: 'connectivity-page',
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      result: { action: message.payload.action },
    }));
  });
  const previewPayload = { action: 'wire_preview', line: [0, 0, 10, 0] };
  const timedOutPreview = assert.rejects(
    connectivityServer.request(connectivityPath, previewPayload, 100),
    /Request execution timeout/,
  );
  await waitUntil(() => previewTasksStarted === 1);
  await timedOutPreview;
  const timeoutSnapshot = await connectivityServer.request('/bridge/admin/clients', {}, 2000);
  const timeoutDiagnostics = timeoutSnapshot.clients[0].quarantine.diagnostics;
  assert.equal(timeoutDiagnostics.length, 1);
  assert.equal(timeoutDiagnostics[0].mutating, false);
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.deepEqual(
    await connectivityServer.request(connectivityPath, { action: 'wire_create', line: [0, 0, 10, 0] }, 2000),
    { action: 'wire_create' },
  );
  const disconnectedPreview = assert.rejects(
    connectivityServer.request(connectivityPath, previewPayload, 2000),
    /disconnected/,
  );
  await waitUntil(() => previewTasksStarted === 2);
  const previewStartedAck = waitForMessage(connectivityClient.socket, message => message.type === 'bridge/heartbeat-ack');
  connectivityClient.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'connectivity-page', sentAt: Date.now() }));
  await previewStartedAck;
  connectivityClient.socket.close();
  await disconnectedPreview;
  const disconnectSnapshot = await connectivityServer.request('/bridge/admin/clients', {}, 2000);
  const disconnectDiagnostics = disconnectSnapshot.clients.find(client => client.clientId === 'connectivity-page').quarantine.diagnostics;
  assert.equal(disconnectDiagnostics.length, 1, 'Disconnecting a started preview must not add a mutation diagnostic');
  assert.equal(disconnectDiagnostics[0].mutating, false);
  connectivityClient = undefined;
  connectivityServer.close();
  connectivityServer = undefined;

  const recoveryPort = await reservePort();
  recoveryServer = new EdaBridgeServer(recoveryPort);
  await recoveryServer.start();
  stuck = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'stuck-page',
    { documentUuid: 'stale-recovery-document', projectUuid: 'stale-recovery-project', pageKind: 'schematic', pageUuid: 'stale-recovery-page' },
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
        context: { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
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
  assert.equal(recoveryStart.diagnostic.context.pageUuid, 'recovery-page', 'write timeout must use the execution page rather than the heartbeat page');
  assert.equal(recoveryStart.diagnostic.context.documentUuid, 'recovery-document');
  const recoveryMessage = await recoveryMessagePromise;
  assert.equal(recoveryMessage.recoveryId, recoveryStart.recoveryId);
  const earlyRecoveryTarget = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'early-recovery-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  attachTaskResponder(earlyRecoveryTarget.socket, 'early-recovery-page', () => ({
    currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' },
    currentProjectInfo: { uuid: 'recovery-project' },
    currentSchematicPageInfo: { uuid: 'recovery-page' },
  }));
  await assert.rejects(recoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: recoveryStart.recoveryId,
    clientId: 'early-recovery-page', readbackPath: '/bridge/jlceda/context',
  }, 2000), /original Bridge client must disconnect/);
  await assert.rejects(recoveryServer.request('/bridge/test/write-before-source-disconnect', {}, 2000), /writes are blocked pending recovery readback/);
  earlyRecoveryTarget.socket.close();
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
    await recoveryServer.request(connectivityPath, previewPayload, 2000),
    { source: 'replacement', path: connectivityPath },
  );
  for (const action of ['wire_create', 'netport_create', 'netport_move']) {
    await assert.rejects(
      recoveryServer.request(connectivityPath, { action }, 2000),
      /writes are blocked pending recovery readback/,
    );
  }
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
  let disconnectedLayoutTask;
  disconnectedRecoveryOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      if (message.payload?.apiFullName === 'eda.pcb_Document.autoLayout') {
        disconnectedLayoutTask = message;
      }
      disconnectedRecoveryOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'disconnected-recovery-old',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
        context: { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
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
  assert.ok(disconnectedLayoutTask);
  const lateTimeoutProcessed = waitForMessage(disconnectedRecoveryOld.socket, (message) => message.type === 'bridge/heartbeat-ack');
  disconnectedRecoveryOld.socket.send(JSON.stringify({
    type: 'bridge/result',
    clientId: 'disconnected-recovery-old',
    requestId: disconnectedLayoutTask.requestId,
    leaseTerm: disconnectedLayoutTask.leaseTerm,
    error: { code: 'BRIDGE_TASK_TIMEOUT', message: 'Bridge task timed out after 100ms: /bridge/jlceda/api/invoke', timeoutMs: 100 },
  }));
  disconnectedRecoveryOld.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'disconnected-recovery-old', sentAt: Date.now() }));
  await lateTimeoutProcessed;
  const lateTimeoutSnapshot = await disconnectedRecoveryServer.request('/bridge/admin/clients', {}, 2000);
  assert.ok(lateTimeoutSnapshot.clients
    .find((client) => client.clientId === 'disconnected-recovery-old')
    .quarantine.diagnostics.some((diagnostic) => diagnostic.requestId === disconnectedLayoutTask.requestId),
  'late BRIDGE_TASK_TIMEOUT must preserve the pending write diagnostic');
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-late-timeout', {}, 2000), /writes are blocked pending recovery readback/);
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
  // Ordinary reconnects retain the runtime clientId, even though they use a
  // new WebSocket. Neither the old source nor the old standby is a new host.
  disconnectedRecoveryTarget = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-target',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-target', readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  }, 2000), /not a fresh Bridge generation/);
  disconnectedRecoveryTarget.socket.close();
  disconnectedRecoveryTarget = undefined;
  disconnectedRecoveryOld = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-old',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-old', readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  }, 2000), /not a fresh Bridge generation/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-old-runtime-reconnect', {}, 2000), /writes are blocked pending recovery readback/);
  disconnectedRecoveryOld.socket.close();
  disconnectedRecoveryOld = undefined;
  disconnectedRecoveryFresh = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-fresh',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  let pcbReadbackPageUuid = 'different-pcb';
  let pcbPositionReadbackValid = true;
  attachTaskResponder(disconnectedRecoveryFresh.socket, 'disconnected-recovery-fresh', (message) => {
    if (message.path === '/bridge/jlceda/context') {
      return { currentDocumentInfo: { uuid: 'disconnected-document', parentProjectUuid: 'disconnected-project' }, currentProjectInfo: { uuid: 'disconnected-project' }, currentPcbInfo: { uuid: pcbReadbackPageUuid } };
    }
    if (message.path === '/bridge/jlceda/api/invoke') {
      assert.equal(message.payload.includeCompletePositions, true);
      return pcbPositionReadbackValid
        ? { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'pcb-component-1' }], componentPositions: [{ primitiveId: 'pcb-component-1', designator: 'U1', x: 100, y: 200, rotation: 0 }], componentCount: 1 }
        : { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [], componentPositions: [], componentCount: 1 };
    }
    return { source: 'disconnected-recovery-fresh', path: message.path };
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-fresh',
  }, 2000), /autoLayout requires eda.pcb_PrimitiveComponent.getAll/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-context-only', {}, 2000), /writes are blocked pending recovery readback/);
  const disconnectedReadbackRequest = {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-fresh',
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
  disconnectedRecoveryFresh.socket.close();
  disconnectedRecoveryFresh = undefined;
  disconnectedRecoveryTarget = undefined;
  disconnectedRecoveryServer.close();
  disconnectedRecoveryServer = undefined;

  const nativeLayoutPort = await reservePort();
  nativeLayoutServer = new EdaBridgeServer(nativeLayoutPort);
  await nativeLayoutServer.start();
  nativeLayoutOld = await registerEda(
    `ws://127.0.0.1:${nativeLayoutPort}/bridge/ws${tokenQuery}`,
    'native-layout-page',
    { documentUuid: 'stale-layout-document', projectUuid: 'stale-layout-project', pageKind: 'pcb', pageUuid: 'stale-layout-pcb' },
  );
  attachTaskResponder(nativeLayoutOld.socket, 'native-layout-page', () => ({
    apiFullName: 'eda.pcb_Document.autoLayout',
    ok: false,
    commitState: 'unknown',
    retryBlocked: true,
    pcbUuid: 'native-layout-pcb',
    layoutContext: { pageKind: 'pcb', pageUuid: 'native-layout-pcb', documentUuid: 'native-layout-document', projectUuid: 'native-layout-project' },
    error: 'RPC Call autoLayout Timed Out',
  }));
  const nativeLayoutResult = await nativeLayoutServer.request('/bridge/jlceda/api/invoke', {
    apiFullName: 'eda.pcb_Document.autoLayout', args: [],
  }, 2000);
  assert.equal(nativeLayoutResult.commitState, 'unknown');
  const nativeLayoutSnapshot = await nativeLayoutServer.request('/bridge/admin/clients', {}, 2000);
  const nativeLayoutDiagnostic = nativeLayoutSnapshot.clients[0].quarantine.diagnostics[0];
  assert.equal(nativeLayoutDiagnostic.requiredReadback, 'pcb_component_positions');
  assert.equal(nativeLayoutDiagnostic.uncertaintyReason, 'native autoLayout timeout');
  assert.equal(nativeLayoutDiagnostic.context.pageUuid, 'native-layout-pcb', 'execution-time result must replace the stale heartbeat page');
  assert.equal(nativeLayoutDiagnostic.context.documentUuid, 'native-layout-document');
  await assert.rejects(nativeLayoutServer.request('/bridge/test/write-after-native-layout-timeout', {}, 2000), /writes are blocked pending recovery readback/);
  const nativeLayoutRecovery = await nativeLayoutServer.request('/bridge/admin/recover-client', {
    confirm: true, requestId: nativeLayoutDiagnostic.requestId,
  }, 2000);
  assert.equal(nativeLayoutRecovery.sourceConnected, true);
  nativeLayoutNew = await registerEda(
    `ws://127.0.0.1:${nativeLayoutPort}/bridge/ws${tokenQuery}`,
    'native-layout-new',
    { documentUuid: 'native-layout-document', projectUuid: 'native-layout-project', pageKind: 'pcb', pageUuid: 'native-layout-pcb' },
  );
  attachTaskResponder(nativeLayoutNew.socket, 'native-layout-new', (message) => {
    if (message.path === '/bridge/jlceda/context')
      return { currentDocumentInfo: { uuid: 'native-layout-document', parentProjectUuid: 'native-layout-project' }, currentProjectInfo: { uuid: 'native-layout-project' }, currentPcbInfo: { uuid: 'native-layout-pcb' } };
    assert.equal(message.payload.includeCompletePositions, true);
    return { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'native-component-1' }], componentPositions: [{ primitiveId: 'native-component-1', designator: 'R1', x: 1, y: 2, rotation: 0 }], componentCount: 1 };
  });
  await assert.rejects(nativeLayoutServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: nativeLayoutRecovery.recoveryId, clientId: 'native-layout-new',
    readbackPath: '/bridge/jlceda/context',
  }, 2000), /autoLayout requires eda.pcb_PrimitiveComponent.getAll/);
  const nativeLayoutReadbackRequest = {
    action: 'readback', confirm: true, recoveryId: nativeLayoutRecovery.recoveryId, clientId: 'native-layout-new',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  };
  await assert.rejects(nativeLayoutServer.request('/bridge/admin/recover-client', nativeLayoutReadbackRequest, 2000), /original Bridge client must disconnect/);
  await assert.rejects(nativeLayoutServer.request('/bridge/test/write-while-native-layout-source-connected', {}, 2000), /writes are blocked pending recovery readback/);
  nativeLayoutOld.socket.close();
  await waitUntil(async () => (await nativeLayoutServer.request('/bridge/admin/clients', {}, 2000)).clients
    .find((client) => client.clientId === 'native-layout-page')?.ready === false);
  const nativeLayoutReadback = await nativeLayoutServer.request('/bridge/admin/recover-client', nativeLayoutReadbackRequest, 2000);
  assert.equal(nativeLayoutReadback.readbackVerified, true);
  assert.equal(nativeLayoutReadback.writesRemainBlocked, false);
  nativeLayoutNew.socket.close();
  nativeLayoutOld = undefined;
  nativeLayoutNew = undefined;
  nativeLayoutServer.close();
  nativeLayoutServer = undefined;

  const lateUnknownPort = await reservePort();
  lateUnknownServer = new EdaBridgeServer(lateUnknownPort);
  await lateUnknownServer.start();
  lateUnknownClient = await registerEda(
    `ws://127.0.0.1:${lateUnknownPort}/bridge/ws${tokenQuery}`,
    'late-unknown-page',
    { documentUuid: 'stale-late-document', projectUuid: 'stale-late-project', pageKind: 'pcb', pageUuid: 'stale-late-pcb' },
  );
  let lateUnknownTask;
  lateUnknownClient.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    lateUnknownTask = message;
    lateUnknownClient.socket.send(JSON.stringify({
      type: 'bridge/task-started', clientId: 'late-unknown-page',
      requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
      context: { documentUuid: 'late-unknown-document', projectUuid: 'late-unknown-project', pageKind: 'pcb', pageUuid: 'late-unknown-pcb' },
    }));
  });
  await assert.rejects(lateUnknownServer.request('/bridge/jlceda/api/invoke', {
    apiFullName: 'eda.pcb_Document.autoLayout', args: [],
  }, 100), /Request execution timeout/);
  assert.ok(lateUnknownTask);
  const beforeLateResult = await lateUnknownServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(beforeLateResult.clients[0].quarantine.diagnostics[0].context.pageUuid, 'late-unknown-pcb',
    'a Server timeout must retain task-start PCB identity rather than the stale heartbeat');
  assert.equal(beforeLateResult.clients[0].quarantine.diagnostics[0].context.documentUuid, 'late-unknown-document');
  const lateUnknownProcessed = waitForMessage(lateUnknownClient.socket, (message) => message.type === 'bridge/heartbeat-ack');
  lateUnknownClient.socket.send(JSON.stringify({
    type: 'bridge/result', clientId: 'late-unknown-page',
    requestId: lateUnknownTask.requestId, leaseTerm: lateUnknownTask.leaseTerm,
    result: { apiFullName: 'eda.pcb_Document.autoLayout', ok: false, commitState: 'unknown', retryBlocked: true, pcbUuid: 'late-unknown-pcb', layoutContext: { documentUuid: 'late-unknown-document', projectUuid: 'late-unknown-project', pageKind: 'pcb', pageUuid: 'late-unknown-pcb' } },
  }));
  lateUnknownClient.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-unknown-page', sentAt: Date.now() }));
  await lateUnknownProcessed;
  const lateUnknownSnapshot = await lateUnknownServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(lateUnknownSnapshot.clients[0].quarantine.diagnostics[0].requestId, lateUnknownTask.requestId);
  await assert.rejects(lateUnknownServer.request('/bridge/test/write-after-late-unknown', {}, 2000), /writes are blocked pending recovery readback/);
  lateUnknownClient.socket.close();
  lateUnknownClient = undefined;
  lateUnknownServer.close();
  lateUnknownServer = undefined;

  const missingLayoutIdentityPort = await reservePort();
  const missingLayoutIdentityServer = new EdaBridgeServer(missingLayoutIdentityPort);
  let missingLayoutIdentityOld;
  let missingLayoutIdentityFresh;
  try {
    await missingLayoutIdentityServer.start();
    const identityUrl = `ws://127.0.0.1:${missingLayoutIdentityPort}/bridge/ws${tokenQuery}`;
    missingLayoutIdentityOld = await registerEda(identityUrl, 'missing-layout-identity-old', {
      documentUuid: 'heartbeat-document', projectUuid: 'heartbeat-project', pageKind: 'pcb', pageUuid: 'heartbeat-pcb',
    });
    missingLayoutIdentityOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      missingLayoutIdentityOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'missing-layout-identity-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
      }));
    });
    await assert.rejects(missingLayoutIdentityServer.request('/bridge/jlceda/api/invoke', {
      apiFullName: 'eda.pcb_Document.autoLayout', args: [],
    }, 100), /Request execution timeout/);
    const missingSnapshot = await missingLayoutIdentityServer.request('/bridge/admin/clients', {}, 2000);
    const missingDiagnostic = missingSnapshot.clients[0].quarantine.diagnostics[0];
    assert.equal(missingDiagnostic.context.pageUuid, undefined, 'heartbeat PCB must not be treated as execution identity');
    const recovery = await missingLayoutIdentityServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: missingDiagnostic.requestId,
    }, 2000);
    missingLayoutIdentityFresh = await registerEda(identityUrl, 'missing-layout-identity-fresh', {
      documentUuid: 'heartbeat-document', projectUuid: 'heartbeat-project', pageKind: 'pcb', pageUuid: 'heartbeat-pcb',
    });
    await assert.rejects(missingLayoutIdentityServer.request('/bridge/admin/recover-client', {
      action: 'readback', confirm: true, recoveryId: recovery.recoveryId, clientId: 'missing-layout-identity-fresh',
      expectedDocumentUuid: 'heartbeat-document', expectedPageUuid: 'heartbeat-pcb',
      readbackPath: '/bridge/jlceda/api/invoke',
      readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
    }, 2000), /no verified execution-time PCB page identity/);
  } finally {
    missingLayoutIdentityOld?.socket.close();
    missingLayoutIdentityFresh?.socket.close();
    missingLayoutIdentityServer.close();
  }

  const lateConnectivityPort = await reservePort();
  lateConnectivityServer = new EdaBridgeServer(lateConnectivityPort);
  await lateConnectivityServer.start();
  lateConnectivityActive = await registerEda(
    `ws://127.0.0.1:${lateConnectivityPort}/bridge/ws${tokenQuery}`,
    'late-connectivity-active',
    { documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page' },
  );
  let lateConnectivityTask;
  lateConnectivityActive.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    lateConnectivityTask = message;
    lateConnectivityActive.socket.send(JSON.stringify({
      type: 'bridge/task-started', clientId: 'late-connectivity-active',
      requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
    }));
  });
  lateConnectivityStandby = await registerEda(
    `ws://127.0.0.1:${lateConnectivityPort}/bridge/ws${tokenQuery}`,
    'late-connectivity-standby',
    { documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page' },
  );
  attachTaskResponder(lateConnectivityStandby.socket, 'late-connectivity-standby', (message) => ({
    source: 'late-connectivity-standby', path: message.path,
  }));
  await assert.rejects(lateConnectivityServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'wire_create', line: [0, 0, 10, 0],
  }, 100), /Request execution timeout/);
  assert.ok(lateConnectivityTask);
  const lateConnectivityProcessed = waitForMessage(lateConnectivityActive.socket, (message) => message.type === 'bridge/heartbeat-ack');
  lateConnectivityActive.socket.send(JSON.stringify({
    type: 'bridge/result', clientId: 'late-connectivity-active',
    requestId: lateConnectivityTask.requestId, leaseTerm: lateConnectivityTask.leaseTerm,
    result: { ok: false, action: 'wire_create', committed: false, commitUnknown: true },
  }));
  lateConnectivityActive.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-connectivity-active', sentAt: Date.now() }));
  await lateConnectivityProcessed;
  const lateConnectivitySnapshot = await lateConnectivityServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(lateConnectivitySnapshot.clients.find(client => client.clientId === 'late-connectivity-active').quarantine.diagnostics[0].requestId, lateConnectivityTask.requestId);
  await lateConnectivityServer.request('/bridge/admin/select-client', { clientId: 'late-connectivity-standby' }, 2000);
  assert.deepEqual(await lateConnectivityServer.request('/bridge/jlceda/context', {}, 2000), {
    source: 'late-connectivity-standby', path: '/bridge/jlceda/context',
  });
  await assert.rejects(lateConnectivityServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'netport_create', net: 'SIG', x: 0, y: 0,
  }, 2000), /writes are blocked pending recovery readback/);
  lateConnectivityActive.socket.close();
  lateConnectivityActive = undefined;
  lateConnectivityStandby.socket.close();
  lateConnectivityStandby = undefined;
  lateConnectivityServer.close();
  lateConnectivityServer = undefined;

  const unverifiedWritePort = await reservePort();
  unverifiedWriteServer = new EdaBridgeServer(unverifiedWritePort);
  await unverifiedWriteServer.start();
  unverifiedWriteActive = await registerEda(
    `ws://127.0.0.1:${unverifiedWritePort}/bridge/ws${tokenQuery}`,
    'unverified-write-active',
    { documentUuid: 'stale-unverified-document', projectUuid: 'stale-unverified-project', pageKind: 'schematic', pageUuid: 'stale-unverified-page' },
  );
  unverifiedWriteActive.socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    unverifiedWriteActive.socket.send(JSON.stringify({
      type: 'bridge/task-started', clientId: 'unverified-write-active',
      requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
      context: { documentUuid: 'unverified-document', projectUuid: 'unverified-project', pageKind: 'schematic', pageUuid: 'unverified-page' },
    }));
    unverifiedWriteActive.socket.send(JSON.stringify({
      type: 'bridge/result', clientId: 'unverified-write-active',
      requestId: message.requestId, leaseTerm: message.leaseTerm,
      result: { ok: false, action: 'wire_create', committed: false, commitUnknown: true },
    }));
  });
  unverifiedWriteStandby = await registerEda(
    `ws://127.0.0.1:${unverifiedWritePort}/bridge/ws${tokenQuery}`,
    'unverified-write-standby',
    { documentUuid: 'unverified-document', projectUuid: 'unverified-project', pageKind: 'schematic', pageUuid: 'unverified-page' },
  );
  attachTaskResponder(unverifiedWriteStandby.socket, 'unverified-write-standby', (message) => ({
    source: 'unverified-write-standby', path: message.path,
  }));
  const unverifiedResult = await unverifiedWriteServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'wire_create', line: [0, 0, 10, 0],
  }, 2000);
  assert.equal(unverifiedResult.commitUnknown, true);
  const unverifiedSnapshot = await unverifiedWriteServer.request('/bridge/admin/clients', {}, 2000);
  const unverifiedDiagnostic = unverifiedSnapshot.clients.find(client => client.clientId === 'unverified-write-active').quarantine.diagnostics[0];
  assert.equal(unverifiedDiagnostic.path, '/bridge/jlceda/schematic/connectivity');
  assert.equal(unverifiedDiagnostic.mutating, true);
  assert.equal(unverifiedDiagnostic.uncertaintyReason, 'write result could not be verified');
  assert.equal(unverifiedDiagnostic.context.pageUuid, 'unverified-page', 'unknown write must use the execution page rather than the heartbeat page');
  assert.equal(unverifiedDiagnostic.context.documentUuid, 'unverified-document');
  await unverifiedWriteServer.request('/bridge/admin/select-client', { clientId: 'unverified-write-standby' }, 2000);
  assert.deepEqual(await unverifiedWriteServer.request('/bridge/jlceda/context', {}, 2000), {
    source: 'unverified-write-standby', path: '/bridge/jlceda/context',
  });
  await assert.rejects(unverifiedWriteServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'netport_create', net: 'SIG', x: 0, y: 0,
  }, 2000), /writes are blocked pending recovery readback/);
  unverifiedWriteActive.socket.close();
  unverifiedWriteActive = undefined;
  unverifiedWriteStandby.socket.close();
  unverifiedWriteStandby = undefined;
  unverifiedWriteServer.close();
  unverifiedWriteServer = undefined;

  const projectWritePort = await reservePort();
  const projectWriteServer = new EdaBridgeServer(projectWritePort);
  let projectWriteOld;
  let projectWriteFresh;
  try {
    await projectWriteServer.start();
    const projectUrl = `ws://127.0.0.1:${projectWritePort}/bridge/ws${tokenQuery}`;
    projectWriteOld = await registerEda(projectUrl, 'project-write-old', {
      projectUuid: 'stale-project', pageKind: 'schematic', pageUuid: 'stale-page',
    });
    projectWriteOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      projectWriteOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'project-write-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'project-write-page-a-document', projectUuid: 'current-project', pageKind: 'schematic', pageUuid: 'project-write-page-a' },
      }));
      projectWriteOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'project-write-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { commitUnknown: true },
      }));
    });
    const projectWriteResult = await projectWriteServer.request('/bridge/jlceda/api/invoke', {
      apiFullName: 'eda.dmt_Project.modifyProjectFriendlyName', args: ['actual-project', 'renamed'],
    }, 2000);
    assert.equal(projectWriteResult.commitUnknown, true);
    const projectDiagnostic = (await projectWriteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(projectDiagnostic.pageBound, false);
    assert.equal(projectDiagnostic.targetProjectUuid, 'actual-project');
    assert.equal(projectDiagnostic.context.projectUuid, 'current-project');
    assert.equal(projectDiagnostic.context.pageUuid, 'project-write-page-a');
    const projectRecovery = await projectWriteServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: projectDiagnostic.requestId,
    }, 2000);
    projectWriteOld.socket.close();
    await waitUntil(async () => (await projectWriteServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'project-write-old')?.ready === false);
    projectWriteFresh = await registerEda(projectUrl, 'project-write-fresh', {
      documentUuid: 'project-write-page-b-document', projectUuid: 'actual-project', pageKind: 'schematic', pageUuid: 'project-write-page-b',
    });
    attachTaskResponder(projectWriteFresh.socket, 'project-write-fresh', () => ({
      currentDocumentInfo: { uuid: 'project-write-page-b-document', parentProjectUuid: 'actual-project' },
      currentProjectInfo: { uuid: 'actual-project' },
      currentSchematicPageInfo: { uuid: 'project-write-page-b' },
    }));
    const projectReadback = await projectWriteServer.request('/bridge/admin/recover-client', {
      action: 'readback', confirm: true, recoveryId: projectRecovery.recoveryId,
      clientId: 'project-write-fresh', readbackPath: '/bridge/jlceda/context',
    }, 2000);
    assert.equal(projectReadback.readbackVerified, true);
  } finally {
    projectWriteOld?.socket.close();
    projectWriteFresh?.socket.close();
    projectWriteServer.close();
  }

  const legacyWritePort = await reservePort();
  const legacyWriteServer = new EdaBridgeServer(legacyWritePort);
  let legacyWriteOld;
  let legacyWriteFresh;
  try {
    await legacyWriteServer.start();
    const legacyUrl = `ws://127.0.0.1:${legacyWritePort}/bridge/ws${tokenQuery}`;
    legacyWriteOld = await registerEda(legacyUrl, 'legacy-write-old', {
      documentUuid: 'legacy-document', projectUuid: 'legacy-project', pageKind: 'schematic', pageUuid: 'legacy-page',
    });
    attachTaskResponder(legacyWriteOld.socket, 'legacy-write-old', () => ({ commitUnknown: true }));
    await legacyWriteServer.request('/bridge/jlceda/schematic/connectivity', {
      action: 'wire_create', line: [0, 0, 10, 0],
    }, 2000);
    const legacyDiagnostic = (await legacyWriteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(legacyDiagnostic.pageBound, true);
    assert.equal(legacyDiagnostic.context, undefined, 'old task-started without context must not reuse heartbeat identity');
    const legacyRecovery = await legacyWriteServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: legacyDiagnostic.requestId,
    }, 2000);
    legacyWriteOld.socket.close();
    await waitUntil(async () => (await legacyWriteServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'legacy-write-old')?.ready === false);
    legacyWriteFresh = await registerEda(legacyUrl, 'legacy-write-fresh', {
      documentUuid: 'legacy-document', projectUuid: 'legacy-project', pageKind: 'schematic', pageUuid: 'legacy-page',
    });
    await assert.rejects(legacyWriteServer.request('/bridge/admin/recover-client', {
      action: 'readback', confirm: true, recoveryId: legacyRecovery.recoveryId,
      clientId: 'legacy-write-fresh', expectedDocumentUuid: 'legacy-document', expectedPageUuid: 'legacy-page',
    }, 2000), /no verified execution-time page identity/);
  } finally {
    legacyWriteOld?.socket.close();
    legacyWriteFresh?.socket.close();
    legacyWriteServer.close();
  }

  const crossPageDeletePort = await reservePort();
  const crossPageDeleteServer = new EdaBridgeServer(crossPageDeletePort);
  let crossPageDeleteOld;
  let crossPageDeleteFresh;
  try {
    await crossPageDeleteServer.start();
    const crossPageUrl = `ws://127.0.0.1:${crossPageDeletePort}/bridge/ws${tokenQuery}`;
    crossPageDeleteOld = await registerEda(crossPageUrl, 'cross-page-delete-old', {
      documentUuid: 'page-a-document', projectUuid: 'cross-page-project', pageKind: 'schematic', pageUuid: 'page-a',
    });
    crossPageDeleteOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      crossPageDeleteOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'cross-page-delete-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'page-a-document', projectUuid: 'cross-page-project', pageKind: 'schematic', pageUuid: 'page-a' },
      }));
      crossPageDeleteOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'cross-page-delete-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { commitUnknown: true, uncertainIds: ['component-on-page-b'] },
      }));
    });
    await crossPageDeleteServer.request('/bridge/jlceda/api/invoke', {
      apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['component-on-page-b'],
    }, 2000);
    const crossPageDiagnostic = (await crossPageDeleteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(crossPageDiagnostic.pageBound, false);
    assert.equal(crossPageDiagnostic.requiredReadback, 'schematic_project_review');
    const crossPageRecovery = await crossPageDeleteServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: crossPageDiagnostic.requestId,
    }, 2000);
    crossPageDeleteOld.socket.close();
    await waitUntil(async () => (await crossPageDeleteServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'cross-page-delete-old')?.ready === false);
    crossPageDeleteFresh = await registerEda(crossPageUrl, 'cross-page-delete-fresh', {
      documentUuid: 'page-b-document', projectUuid: 'cross-page-project', pageKind: 'schematic', pageUuid: 'page-b',
    });
    attachTaskResponder(crossPageDeleteFresh.socket, 'cross-page-delete-fresh', message => message.path === '/bridge/jlceda/schematic/review'
      ? { ok: true, netlistText: 'whole-project-netlist' }
      : { currentDocumentInfo: { uuid: 'page-b-document', parentProjectUuid: 'cross-page-project' }, currentProjectInfo: { uuid: 'cross-page-project' }, currentSchematicPageInfo: { uuid: 'page-b' } });
    const crossPageReadback = {
      action: 'readback', confirm: true, recoveryId: crossPageRecovery.recoveryId,
      clientId: 'cross-page-delete-fresh', readbackPath: '/bridge/jlceda/schematic/review',
    };
    await assert.rejects(crossPageDeleteServer.request('/bridge/admin/recover-client', {
      ...crossPageReadback, readbackPath: '/bridge/jlceda/context',
    }, 2000), /requires schematic_review of the whole project/);
    assert.equal((await crossPageDeleteServer.request('/bridge/admin/recover-client', crossPageReadback, 2000)).readbackVerified, true);
  } finally {
    crossPageDeleteOld?.socket.close();
    crossPageDeleteFresh?.socket.close();
    crossPageDeleteServer.close();
  }

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

  const readyPromotionPort = await reservePort();
  const readyPromotionServer = new EdaBridgeServer(readyPromotionPort, { peerTtlMs: 400, peerSweepIntervalMs: 2000 });
  let unreadyPeer;
  let readyPeer;
  let pendingPeer;
  let laterPeer;
  try {
    await readyPromotionServer.start();
    const readyPromotionUrl = `ws://127.0.0.1:${readyPromotionPort}/bridge/ws${tokenQuery}`;
    unreadyPeer = await connect(readyPromotionUrl);
    const firstWelcome = waitForMessage(unreadyPeer, message => message.type === 'bridge/welcome');
    const firstRole = waitForMessage(unreadyPeer, message => message.type === 'bridge/role');
    unreadyPeer.send(JSON.stringify({ type: 'bridge/hello', clientId: 'unready-first', bridgeVersion: '2.3.2' }));
    await firstWelcome;
    assert.equal((await firstRole).role, 'active');
    readyPeer = await registerEda(readyPromotionUrl, 'ready-second');
    let pendingTask;
    let pendingTaskStarted;
    const pendingTaskStartedPromise = new Promise(resolve => { pendingTaskStarted = resolve; });
    readyPeer.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      readyPeer.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'ready-second', requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now() }));
      if (message.path === '/bridge/test/pending-promotion') {
        pendingTask = message;
        pendingTaskStarted();
        return;
      }
      readyPeer.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'ready-second', requestId: message.requestId, leaseTerm: message.leaseTerm, result: { source: 'ready-second', path: message.path } }));
    });
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'ready-second');
    assert.deepEqual(await readyPromotionServer.request('/bridge/jlceda/context', {}, 2000), {
      source: 'ready-second', path: '/bridge/jlceda/context',
    });

    const pendingRequest = readyPromotionServer.request('/bridge/test/pending-promotion', {}, 2000);
    await pendingTaskStartedPromise;
    await new Promise(resolve => setTimeout(resolve, 450));
    pendingPeer = await registerEda(readyPromotionUrl, 'ready-while-pending');
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'ready-second',
      'an active request must not be interrupted by automatic promotion');
    readyPeer.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'ready-second', requestId: pendingTask.requestId, leaseTerm: pendingTask.leaseTerm, result: { completed: true } }));
    assert.deepEqual(await pendingRequest, { completed: true });
    const promotionHeartbeat = waitForMessage(pendingPeer.socket, message => message.type === 'bridge/heartbeat-ack');
    pendingPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'ready-while-pending', sentAt: Date.now() }));
    await promotionHeartbeat;
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'ready-while-pending');

    unreadyPeer.send(JSON.stringify({ type: 'bridge/ready', clientId: 'unready-first', readyAt: Date.now() }));
    const firstHeartbeat = waitForMessage(unreadyPeer, message => message.type === 'bridge/heartbeat-ack');
    unreadyPeer.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'unready-first', sentAt: Date.now() }));
    await firstHeartbeat;
    await readyPromotionServer.request('/bridge/admin/select-client', { clientId: 'unready-first' }, 2000);
    await new Promise(resolve => setTimeout(resolve, 450));
    laterPeer = await registerEda(readyPromotionUrl, 'ready-third');
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'unready-first',
      'a manually selected page must not be replaced when its heartbeat becomes stale');
    await readyPromotionServer.request('/bridge/admin/select-client', { clientId: 'ready-third' }, 2000);
  } finally {
    unreadyPeer?.close();
    readyPeer?.socket.close();
    pendingPeer?.socket.close();
    laterPeer?.socket.close();
    readyPromotionServer.close();
  }

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
  connectivityClient?.socket.close();
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
  disconnectedRecoveryFresh?.socket.close();
  nativeLayoutOld?.socket.close();
  nativeLayoutNew?.socket.close();
  lateUnknownClient?.socket.close();
  lateConnectivityActive?.socket.close();
  lateConnectivityStandby?.socket.close();
  unverifiedWriteActive?.socket.close();
  unverifiedWriteStandby?.socket.close();
  expiryServer?.close();
  livenessServer?.close();
  queueServer?.close();
  connectivityServer?.close();
  recoveryServer?.close();
  disconnectServer?.close();
  edaFirstServer?.close();
  queuedDisconnectServer?.close();
  reconnectServer?.close();
  disconnectedRecoveryServer?.close();
  nativeLayoutServer?.close();
  lateUnknownServer?.close();
  lateConnectivityServer?.close();
  unverifiedWriteServer?.close();
  secondaryServer.close();
  mainServer.close();
  if (originalToken === undefined) {
    delete process.env.JLCEDA_BRIDGE_TOKEN;
  } else {
    process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
  }
}
