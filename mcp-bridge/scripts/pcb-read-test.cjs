const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbReadTask } = require('../src/mcp/pcb-read-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

let page = 'pcb-1';
const calls = { components: 0, componentIds: 0, pins: 0, pads: 0, nets: 0, routing: 0 };

function primitive(values) {
	return new Proxy({}, {
		get(_target, key) {
			if (typeof key === 'string' && key.startsWith('getState_'))
				return () => values[key.slice('getState_'.length)];
			return undefined;
		},
	});
}

const component = primitive({
	PrimitiveId: 'U1',
	Layer: 1,
	X: 10,
	Y: 20,
	Rotation: 0,
	PrimitiveLock: false,
	Designator: 'U1',
	Component: null,
	Footprint: null,
	AddIntoBom: true,
	Name: 'IC',
	UniqueId: null,
	Manufacturer: null,
	ManufacturerId: null,
	Supplier: null,
	SupplierId: null,
	OtherProperty: {},
});

function pad(id, parent) {
	return primitive({
		PrimitiveId: id,
		Layer: 1,
		PadNumber: '1',
		X: 10,
		Y: 20,
		Rotation: 0,
		Net: 'GND',
		PadType: 0,
		ParentComponentPrimitiveId: parent,
	});
}

const boardLine = primitive({
	PrimitiveId: 'outline-1',
	Net: '',
	Layer: 11,
	LineWidth: 0.1,
	PrimitiveLock: false,
	StartX: 0,
	StartY: 0,
	EndX: 30,
	EndY: 0,
});
const region = primitive({
	PrimitiveId: 'region-1',
	Layer: 1,
	ComplexPolygon: { getSource: () => ['R', 0, 0, 30, 20, 0, 0] },
	RuleType: [2],
	RegionName: 'keepout',
	LineWidth: 0.2,
	PrimitiveLock: false,
});

globalThis.eda = {
	dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
	pcb_PrimitiveComponent: {
		async getAll() {
			calls.components += 1;
			return [component];
		},
		async getAllPrimitiveId() {
			calls.componentIds += 1;
			return ['U1'];
		},
		async getAllPinsByPrimitiveId(id) {
			calls.pins += 1;
			assert.equal(id, 'U1');
			return [pad('pin-1', 'U1')];
		},
	},
	pcb_PrimitivePad: {
		async getAll() {
			calls.pads += 1;
			return [pad('pin-1'), ...Array.from({ length: 130 }, (_, index) => pad(`free-${index}`))];
		},
	},
	pcb_Net: { async getAllNets() {
		calls.nets += 1;
		return Array.from({ length: 130 }, (_, index) => ({ net: `N${index}`, length: index }));
	} },
	pcb_PrimitiveLine: { async getAll() {
		calls.routing += 1;
		return [boardLine];
	} },
	pcb_PrimitiveArc: { async getAll() { return []; } },
	pcb_PrimitivePolyline: { async getAll() { return []; } },
	pcb_PrimitiveVia: { async getAll() { return []; } },
	pcb_PrimitivePour: { async getAll() { return []; } },
	pcb_PrimitivePoured: { async getAll() { return []; } },
	pcb_PrimitiveRegion: { async getAll() { return [region]; } },
};

async function main() {
	const basic = await handlePcbReadTask({});
	assert.equal(basic.complete, true);
	assert.equal(basic.pageUuid, 'pcb-1');
	assert.deepEqual(basic.includedSections, ['components', 'nets']);
	assert.deepEqual(basic.omittedSections, ['pads', 'routing', 'pours', 'outline', 'regions']);
	assert.equal(basic.componentCount, 1);
	assert.equal(basic.netCount, 130);
	assert.equal(basic.pads, undefined);
	assert.equal(calls.pads, 0);
	assert.equal(calls.routing, 0);

	const all = await handlePcbReadTask({ sections: ['all'] });
	assert.equal(all.complete, true);
	assert.equal(all.padCount, 131);
	assert.equal(all.pads.find(item => item.primitiveId === 'pin-1').parentComponentPrimitiveId, 'U1');
	assert.equal(all.pads.filter(item => item.primitiveId === 'pin-1').length, 1);
	assert.equal(all.lineCount, 0);
	assert.equal(all.outlineLineCount, 1);
	assert.equal(all.regionCount, 1);
	assert.equal(all.pourCount, 0);
	assert.deepEqual(all.omittedSections, []);
	const serialized = await toSerializableAsync(all);
	assert.equal(serialized.pads.length, 131);
	assert.equal(serialized.nets.length, 130);
	assert.deepEqual(serialized.regions[0].polygonSource, ['R', 0, 0, 30, 20, 0, 0]);
	assert.equal(serialized.outlineLines[0].primitiveId, 'outline-1');

	const padsOnly = await handlePcbReadTask({ sections: ['pads'] });
	assert.equal(padsOnly.padCount, 131);
	assert.equal(calls.componentIds, 1);
	assert.equal(padsOnly.components, undefined);
	await assert.rejects(() => handlePcbReadTask({ sections: ['all', 'nets'] }), /unique values/);
	await assert.rejects(() => handlePcbReadTask({ sections: ['nets', 'nets'] }), /unique values/);

	globalThis.eda.pcb_Net.getAllNets = async () => {
		page = 'pcb-2';
		return [{ net: 'GND' }];
	};
	await assert.rejects(() => handlePcbReadTask({ sections: ['nets'] }), /active PCB changed/);
	page = 'pcb-1';
	globalThis.eda.pcb_Net.getAllNets = async () => undefined;
	await assert.rejects(() => handlePcbReadTask({ sections: ['nets'] }), /network details are not readable/);
	process.stdout.write('PCB read snapshot tests passed\n');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
