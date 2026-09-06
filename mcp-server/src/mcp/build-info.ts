import process from 'node:process';

// The build date is supplied by the packaging environment when available.
// Resolve the fallback once at module load so a long-running server does not
// change its watermark when the calendar date rolls over.
const configuredBuildDate = process.env.MCP_SERVER_BUILD_DATE?.trim();
const fallbackBuildDate = new Date().toISOString().slice(0, 10);

export const SERVER_BUILD_DATE = configuredBuildDate && /^\d{4}-\d{2}-\d{2}$/.test(configuredBuildDate)
  ? configuredBuildDate
  : fallbackBuildDate;
