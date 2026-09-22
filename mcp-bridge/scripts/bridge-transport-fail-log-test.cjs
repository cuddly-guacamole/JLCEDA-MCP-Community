const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { BridgeTransport } = require('../src/runtime/bridge-transport.ts');

// 安装最小 EDA WebSocket 运行时：只需要 register / send / close。
function installEdaRuntime() {
	const closed = [];
	globalThis.eda = {
		sys_WebSocket: {
			register: () => undefined,
			send: () => undefined,
			close: (socketId, code, reason) => closed.push([socketId, code, reason]),
		},
		// debugLog 会尝试持久化；这里接受写入并丢弃，避免污染测试输出。
		sys_Storage: {
			setExtensionUserConfig: () => undefined,
			getExtensionUserConfig: () => undefined,
		},
	};
	return { closed };
}

// 构造一个不依赖真实桥接的传输实例。
function createTransport() {
	const lost = [];
	const transport = new BridgeTransport(
		'ws://127.0.0.1:8765/bridge/ws',
		'test-socket',
		'test-client',
		'2.3.0',
		undefined,
		{
			onRoleChanged: () => undefined,
			onDebugSwitchChanged: () => undefined,
			onTask: () => undefined,
			onRecoveryRequested: () => undefined,
			onLost: (message) => lost.push(message),
		},
	);
	return { transport, lost };
}

// 捕获 debugLog 的 console.log 输出。
async function captureConsole(run) {
	const lines = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...args) => lines.push(args.map(String).join(' '));
	console.error = () => undefined;
	try {
		await run();
	}
	finally {
		console.log = originalLog;
		console.error = originalError;
	}
	return lines;
}

async function main() {
	// 1. fail() 必须留下带 message 与 reason 的归因日志，且不打印超大对象。
	const { closed } = installEdaRuntime();
	const first = createTransport();
	const longReason = 'x'.repeat(600);
	const lines = await captureConsole(async () => {
		first.transport.fail('server idle timeout', longReason);
	});

	const failLine = lines.find((line) => line.includes('bridge-transport fail:'));
	assert.ok(failLine, `fail() must log its message, got: ${JSON.stringify(lines)}`);
	assert.match(failLine, /bridge-transport fail: server idle timeout/);
	assert.match(failLine, /reason:/);
	// 截断：600 字符的原因不得整体写入日志。
	assert.ok(!failLine.includes(longReason), 'a 600-char reason must be truncated');
	assert.match(failLine, /\.\.\.\(truncated \d+ chars\)/);
	assert.ok(failLine.length < 600, `log line must stay bounded, got ${String(failLine.length)} chars`);
	// 归因日志必须带上足以定位的身份信息。
	assert.match(failLine, /socketId: test-socket/);
	assert.match(failLine, /clientId: test-client/);
	// 失效时关闭底层 socket。
	assert.ok(closed.some((entry) => entry[0] === 'test-socket'), 'fail() must close the underlying socket');
	assert.deepEqual(first.lost, ['server idle timeout']);

	// 2. Error 原因取 message；未提供原因时给出明确占位，不得抛错。
	const second = createTransport();
	const secondLines = await captureConsole(async () => {
		second.transport.fail('heartbeat failed', new Error('socket is closing'));
	});
	const secondFail = secondLines.find((line) => line.includes('bridge-transport fail:'));
	assert.match(secondFail, /reason: socket is closing/);

	const noReason = createTransport();
	const noReasonLines = await captureConsole(async () => {
		noReason.transport.fail('no reason supplied');
	});
	assert.match(
		noReasonLines.find((line) => line.includes('bridge-transport fail:')),
		/reason: \(none\)/,
	);

	// 3. 循环引用对象不得让 fail() 二次失败（JSON.stringify 会抛错）。
	const third = createTransport();
	const circular = new Error('circular');
	circular.self = circular;
	const thirdLines = await captureConsole(async () => {
		third.transport.fail('circular reason', circular);
	});
	assert.ok(
		thirdLines.find((line) => line.includes('bridge-transport fail: circular reason')),
		'fail() must survive a reason that JSON.stringify cannot serialize',
	);
	assert.deepEqual(third.lost, ['circular reason']);

	// 4. fail() 只通知一次 onLost，仍保持既有语义。
	const fourth = createTransport();
	await captureConsole(async () => {
		fourth.transport.fail('first');
		fourth.transport.fail('second');
	});
	assert.deepEqual(fourth.lost, ['first']);
}

main().then(() => {
	process.stdout.write('Bridge transport failure log tests passed\n');
	process.exit(0);
}).catch((error) => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exit(1);
});
