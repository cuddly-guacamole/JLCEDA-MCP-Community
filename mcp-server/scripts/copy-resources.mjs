import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(packageRoot, 'src', 'resources');
const outputRoot = resolve(packageRoot, 'dist', 'resources');
const resources = ['agent-instructions.md', 'mcp-tool-definitions.json', 'bridge-contract.json'];

await mkdir(outputRoot, { recursive: true });

for (const resource of resources) {
  await cp(resolve(sourceRoot, resource), resolve(outputRoot, resource));
}

const configuredBuildDate = process.env.MCP_SERVER_BUILD_DATE?.trim();
const buildDate = configuredBuildDate && /^\d{4}-\d{2}-\d{2}$/.test(configuredBuildDate)
  ? configuredBuildDate
  : new Date().toISOString().slice(0, 10);
await writeFile(resolve(packageRoot, 'dist', 'build-info.json'), `${JSON.stringify({ buildDate }, null, 2)}\n`, 'utf8');
