import process from 'node:process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configuredBuildDate = process.env.MCP_SERVER_BUILD_DATE?.trim();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function readGeneratedBuildDate(): string | undefined {
	try {
		const value = JSON.parse(readFileSync(join(moduleDirectory, '..', 'build-info.json'), 'utf8')) as { buildDate?: unknown };
		return typeof value.buildDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.buildDate)
			? value.buildDate
			: undefined;
	}
	catch {
		return undefined;
	}
}

export const SERVER_BUILD_DATE = configuredBuildDate && /^\d{4}-\d{2}-\d{2}$/.test(configuredBuildDate)
	? configuredBuildDate
	: readGeneratedBuildDate() ?? 'unknown';
