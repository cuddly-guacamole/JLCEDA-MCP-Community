const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const {
	handleComponentPlaceStartTask,
	isInteractivePlacementActive,
	isPlacementModeExitRequired,
} = require('../src/mcp/component-place-handler.ts');
const { getPlacementModeWriteRejection } = require('../src/runtime/placement-mode-barrier.ts');

async function main() {
	const originalEda = globalThis.eda;
	const originalDocument = globalThis.document;
	const document = new EventTarget();
	globalThis.document = document;
	let nativeError = new Error('Invalid library device');
	globalThis.eda = {
		dmt_Schematic: {
			async getCurrentSchematicPageInfo() { return { uuid: 'page-1' }; },
		},
		sch_PrimitiveComponent: {
			async getAllPrimitiveId() { return []; },
			async getAll() { return []; },
			async placeComponentWithMouse() { throw nativeError; },
		},
	};
	const request = { component: { uuid: 'device-1', libraryUuid: 'library-1' } };
	const exitPlacementMode = () => {
		const event = new Event('keyup');
		Object.defineProperty(event, 'key', { value: 'Escape' });
		document.dispatchEvent(event);
	};

	try {
		const rejected = await handleComponentPlaceStartTask(request);
		assert.equal(rejected.ok, false);
		assert.match(rejected.error, /Invalid library device/);
		assert.equal(rejected.commitUnknown, undefined);
		assert.equal(isInteractivePlacementActive(), false);
		assert.equal(isPlacementModeExitRequired(), false);

		for (const message of ['RPC Call placeComponentWithMouse Timed Out', 'Connection closed']) {
			nativeError = new Error(message);
			const uncertain = await handleComponentPlaceStartTask(request);
			assert.equal(uncertain.ok, false);
			assert.equal(uncertain.commitUnknown, true);
			assert.equal(uncertain.readbackRequired, true);
			assert.equal(uncertain.nativeCallSettled, false);
			assert.equal(isInteractivePlacementActive(), false);
			assert.equal(isPlacementModeExitRequired(), true);
			assert.match(getPlacementModeWriteRejection('/bridge/jlceda/component/place-auto', {}), /Esc/);
			const blocked = await handleComponentPlaceStartTask(request);
			assert.equal(blocked.ok, false);
			assert.match(blocked.error, /Esc/);
			exitPlacementMode();
			assert.equal(isPlacementModeExitRequired(), false);
		}
	}
	finally {
		exitPlacementMode();
		globalThis.eda = originalEda;
		globalThis.document = originalDocument;
	}
}

main().then(() => console.log('component place start recovery tests passed')).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
