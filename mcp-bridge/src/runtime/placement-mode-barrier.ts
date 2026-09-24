import { isReadOnlyBridgeRequest } from '../bridge/bridge-contract.ts';
import { isInteractivePlacementActive, isPlacementModeExitRequired } from '../mcp/component-place-handler.ts';

const PLACEMENT_MODE_EXIT_REQUIRED_MESSAGE = 'EDA 可能仍处于器件交互放置模式；请先按 Esc 或右键退出，再执行写操作。';
const ACTIVE_PLACEMENT_MESSAGE = 'EDA 正在交互放置器件；请先结束当前放置会话，再执行其他写操作。';

export function getPlacementModeWriteRejection(path: string, payload: unknown): string | undefined {
	if (isReadOnlyBridgeRequest(path, payload))
		return undefined;
	if (isPlacementModeExitRequired())
		return PLACEMENT_MODE_EXIT_REQUIRED_MESSAGE;
	if (isInteractivePlacementActive())
		return ACTIVE_PLACEMENT_MESSAGE;
}
