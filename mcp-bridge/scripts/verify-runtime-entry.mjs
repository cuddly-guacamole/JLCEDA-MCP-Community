import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');

for (const marker of ['bridge/hello', 'bridge/heartbeat', 'bridge/ready', 'getCurrentProjectInfo']) {
	assert.ok(bundle.includes(marker), `Packaged runtime is missing required marker: ${marker}`);
}

assert.ok(
	!bundle.includes('Starting bridge runtime (client mode)'),
	'Packaged runtime still contains the obsolete client-mode entry',
);

// 写路径重连修复：断线重连前必须轮换 clientId，否则服务端会把新 socket
// 判成同一 clientId 的替换连接，从而拒绝旧 socket 上仍在等待的写请求。
assert.ok(
	/function rotateClientId\(\)\s*\{\s*clientId = "";/.test(bundle),
	'Packaged runtime is missing the clientId rotation applied on reconnect',
);
assert.ok(
	/onLost: \(message\) => \{[\s\S]{0,400}?rotateClientId\(\);/.test(bundle),
	'onLost must rotate the clientId before scheduling a reconnect',
);

// 可观测性：传输失效必须留下归因日志。
assert.ok(
	bundle.includes('bridge-transport fail:'),
	'Packaged runtime is missing the bridge transport failure log',
);

// 提交路径：component_move 首选单次 modify，并回报实际生效的路径。
assert.ok(
	bundle.includes('appliedVia'),
	'Packaged runtime is missing the component_move appliedVia reporting',
);

process.stdout.write('Packaged runtime entry verification passed\n');
