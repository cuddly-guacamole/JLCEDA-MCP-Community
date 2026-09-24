const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicReadTask } = require('../src/mcp/schematic-read-handler.ts');

const existingComponent = {
	getState_PrimitiveId: () => 'old-page-component',
	getState_Designator: () => 'R1',
	getState_Net: () => '',
	getState_Name: () => 'Resistor',
	getState_SubPartName: () => '',
};

let currentPage = 'P1';
globalThis.eda = {
	sch_PrimitiveComponent: {
		async getAll(_componentType, allSchematicPages) {
			return currentPage === 'P1' || allSchematicPages ? [existingComponent] : [];
		},
		async getAllPinsByPrimitiveId() { return []; },
	},
	sch_PrimitiveWire: { async getAll() { return []; } },
	sch_Drc: { async check() { return true; } },
};

async function readCount() {
	const result = await handleSchematicReadTask({});
	assert.equal(result.ok, true);
	return JSON.parse(result.schematicCircuitSnapshot).componentCount;
}

async function main() {
	assert.equal(await readCount(), 1);
	currentPage = 'P2';
	assert.equal(await readCount(), 0, 'a newly opened empty page must not include earlier-page components');
	console.log('schematic_read current-page test passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
