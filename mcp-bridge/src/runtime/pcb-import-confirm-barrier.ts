import { isPlainObjectRecord } from '../utils.ts';

let pendingRequestId: string | undefined;

export function markPcbImportPending(requestId: string): void {
	pendingRequestId = requestId;
}

export function hasPendingPcbImport(): boolean {
	return pendingRequestId !== undefined;
}

export function getPcbImportWriteRejection(): string | undefined {
	return pendingRequestId
		? `PCB import confirmation is pending for request ${pendingRequestId}. Finish the native EDA dialog, then resolve it with bridge_recover_client before writing again.`
		: undefined;
}

export async function handlePcbImportResolveTask(payload: unknown): Promise<Record<string, unknown>> {
	if (!isPlainObjectRecord(payload)
		|| payload.confirm !== true
		|| (payload.resolution !== 'applied' && payload.resolution !== 'cancelled')
		|| typeof payload.requestId !== 'string'
		|| typeof payload.expectedPageUuid !== 'string'
		|| !payload.expectedPageUuid.trim()) {
		throw new TypeError('PCB import resolution requires confirm=true, applied/cancelled resolution, requestId, and expectedPageUuid.');
	}
	if (pendingRequestId !== payload.requestId)
		throw new Error('PCB import resolution requestId does not match the pending native dialog.');
	const pcbInfo = await eda.dmt_Pcb.getCurrentPcbInfo();
	if (pcbInfo?.uuid !== payload.expectedPageUuid)
		throw new Error('Current PCB page does not match the pending import; writes remain blocked.');
	// Only the explicit, identity-checked acknowledgement releases this host's guard.
	pendingRequestId = undefined;
	return { ok: true, action: 'resolve_import', resolution: payload.resolution, pageUuid: pcbInfo.uuid };
}
