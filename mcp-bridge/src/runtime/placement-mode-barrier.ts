import { isReadOnlyBridgeRequest } from '../bridge/bridge-contract.ts';
import { isPlacementModeExitRequired } from '../mcp/component-place-handler.ts';

const PLACEMENT_MODE_EXIT_REQUIRED_MESSAGE = 'EDA 可能仍处于器件交互放置模式；请先按 Esc 或右键退出，再执行写操作。';

export function getPlacementModeWriteRejection(path: string, payload: unknown): string | undefined {
	if (isPlacementModeExitRequired() && !isReadOnlyBridgeRequest(path, payload))
		return PLACEMENT_MODE_EXIT_REQUIRED_MESSAGE;
}
