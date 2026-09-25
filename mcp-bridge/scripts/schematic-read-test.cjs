const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicReadTask } = require('../src/mcp/schematic-read-handler.ts');
const { toSerializable } = require('../src/utils.ts');

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
	let pinX = 100;
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
			getState_X: () => pinX,
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
	// A branch endpoint on a trunk midpoint is a normal T junction, even with no pin at the junction.
	pinX = 50;
	pinY = 100;
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [
		{ getState_Line: () => [0, 0, 100, 0], getState_Net: () => '' },
		{ getState_Line: () => [50, 0, 50, 100], getState_Net: () => '' },
	];
	const tJunction = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.deepEqual(tJunction.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1'], 'a T junction must carry a NetPort name through the branch to its pin');

	const wires = Array.from({ length: 121 }, (_, index) => ({
		getState_PrimitiveId: () => `wire-${index}`,
		getState_Line: () => [index * 20, 0, index * 20 + 10, 0],
		getState_Net: () => index === 0 ? 'SIG' : undefined,
	}));
	const label = {
		getState_PrimitiveId: () => 'label-1',
		getState_Key: () => 'NET',
		getState_ParentPrimitiveId: () => 'wire-0',
		getState_Value: () => 'SIG',
		getState_X: () => 5,
		getState_Y: () => 0,
	};
	globalThis.eda.dmt_Schematic = {
		async getCurrentSchematicPageInfo() {
			return { uuid: currentPage };
		},
	};
	globalThis.eda.sch_PrimitiveWire.getAll = async () => wires;
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'net-port',
				getState_Net: () => 'SIG',
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: [netPort, device];
	globalThis.eda.sch_PrimitiveAttribute = {
		async getAll() {
			return [label];
		},
	};
	const completeReadback = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(completeReadback.ok, true);
	const serialized = toSerializable(completeReadback);
	const primitiveSnapshot = JSON.parse(serialized.connectivityPrimitivesSnapshot);
	assert.equal(primitiveSnapshot.pageUuid, 'P2');
	assert.equal(primitiveSnapshot.wireCount, 121, 'recovery must retain more than the normal 120-item serialization cap');
	assert.equal(primitiveSnapshot.wires.length, 121);
	assert.deepEqual(primitiveSnapshot.wires[120].line, [2400, 0, 2410, 0]);
	assert.deepEqual(primitiveSnapshot.netPorts, [{ primitiveId: 'net-port', net: 'SIG', x: 0, y: 0 }]);
	assert.deepEqual(primitiveSnapshot.netLabels, [{ primitiveId: 'label-1', parentWireId: 'wire-0', net: 'SIG', x: 5, y: 0 }]);
	assert.equal(primitiveSnapshot.wires[1].net, '', 'unnamed wires may return undefined net');
	assert.equal(completeReadback.schematicCircuitSnapshot !== undefined, true);

	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'net-port',
				getState_Net: () => undefined,
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: [netPort, device];
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'NetPort network must be readable');
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'net-port',
				getState_Net: () => 'SIG',
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: [netPort, device];
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = (() => {
		let calls = 0;
		return async () => ({ uuid: ++calls === 1 ? 'P2' : 'P3' });
	})();
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'page switch during readback must fail');
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = async () => ({ uuid: currentPage });
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => undefined;
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'failed pin read must not clear recovery');
	globalThis.eda.sch_PrimitiveWire.getAll = async () => undefined;
	assert.equal((await handleSchematicReadTask({})).ok, false, 'failed wire read must not produce a partial semantic snapshot');
	console.log('schematic_read current-page test passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
