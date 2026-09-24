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

	let portX = 0;
	let pinY = 100;
	const netPort = {
		getState_PrimitiveId: () => 'net-port',
		getState_Designator: () => '',
		getState_Net: () => 'SIG',
		getState_X: () => portX,
		getState_Y: () => 0,
	};
	const device = {
		getState_PrimitiveId: () => 'device',
		getState_Designator: () => 'U1',
		getState_Net: () => '',
		getState_Name: () => 'Device',
		getState_SubPartName: () => '',
	};
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [netPort, device];
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id) => {
		if (id !== 'device')
			return [];
		return [{
			getState_PinNumber: () => '1',
			getState_PinName: () => 'IN',
			getState_PinType: () => 'input',
			getState_X: () => 100,
			getState_Y: () => pinY,
			getState_NoConnected: () => false,
		}];
	};
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [{
		getState_Line: () => [[0, 0, 100, 0], [100, 0, 100, 100]],
		getState_Net: () => '',
	}];
	const result = await handleSchematicReadTask({});
	assert.equal(result.ok, true);
	const snapshot = JSON.parse(result.schematicCircuitSnapshot);
	assert.deepEqual(snapshot.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1']);
	portX = 50;
	const portMidpoint = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.deepEqual(portMidpoint.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1'], 'NetPort on an unnamed wire midpoint must name the connected pin');
	portX = 0;
	pinY = 50;
	const pinMidpoint = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.deepEqual(pinMidpoint.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1'], 'pin on an unnamed wire midpoint must inherit the NetPort name');
	console.log('schematic_read current-page test passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
