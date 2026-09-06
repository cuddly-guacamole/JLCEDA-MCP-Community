/**
 * ------------------------------------------------------------------------
 * 名称：Bridge 日志派发管道
 * 说明：统一处理日志去重、噪音抑制、队列缓存与向服务端派发。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-20
 * 备注：仅处理发送策略，不负责日志实体构造。
 * ------------------------------------------------------------------------
 */

import type { BridgeDebugSwitch } from '../bridge/protocol.ts';
import type { UnifiedLogEntry } from './log.ts';
import { bridgeLogPipeline } from './log.ts';

const BRIDGE_LOG_QUEUE_LIMIT = 200;
const BRIDGE_LOG_DUP_WINDOW_MS = 1500;
const BRIDGE_LOG_NOISE_WINDOW_MS = 8000;
const DEFAULT_DEBUG_SWITCH: BridgeDebugSwitch = {
	enableSystemLog: true,
	enableConnectionList: true,
};
const NOISE_LOG_EVENTS = new Set([
	'status.connecting',
	'status.failed',
	'status.bridge.waiting',
]);
const NOISE_LOG_MESSAGE_TOKENS = [
	'心跳',
	'重连',
	'无响应',
	'连接失败，系统将自动重试',
];

interface LogReportTransport {
	reportLog: (logEntry: UnifiedLogEntry) => void;
}

/**
 * Bridge 日志派发管道。
 */
export class BridgeLogDispatchPipeline {
	private currentDebugSwitch: BridgeDebugSwitch = { ...DEFAULT_DEBUG_SWITCH };
	private hasReceivedDebugSwitch = false;
	private readonly pendingLogs: UnifiedLogEntry[] = [];
	private readonly logReportAtByKey = new Map<string, number>();
	private flushing = false;

	// 规范化服务端下发的调试开关。
	private normalizeDebugSwitch(debugSwitch: BridgeDebugSwitch): BridgeDebugSwitch {
		return {
			enableSystemLog: debugSwitch.enableSystemLog !== false,
			enableConnectionList: debugSwitch.enableConnectionList !== false,
		};
	}

	// 生成日志去重键。
	private createLogKey(logEntry: UnifiedLogEntry): string {
		const fields = logEntry.fields;
		return [
			String(fields.module ?? '').trim(),
			String(fields.event ?? '').trim(),
			String(fields.summary ?? '').trim(),
			String(fields.message ?? '').trim(),
			String(fields.detail ?? '').trim(),
			String(fields.errorCode ?? '').trim(),
			String(fields.requestId ?? '').trim(),
			String(fields.bridgePath ?? '').trim(),
			String(fields.toolName ?? '').trim(),
			String(fields.phase ?? '').trim(),
		].join('|');
	}

	// 判断当前日志是否属于高频噪音日志。
	private isNoiseLog(logEntry: UnifiedLogEntry): boolean {
		const fields = logEntry.fields;
		const event = String(fields.event ?? '').trim();
		if (NOISE_LOG_EVENTS.has(event)) {
			return true;
		}

		const mergedText = [fields.summary, fields.message, fields.detail]
			.map(value => String(value ?? '').trim())
			.filter(value => value.length > 0)
			.join(' ');

		return NOISE_LOG_MESSAGE_TOKENS.some(token => mergedText.includes(token));
	}

	// 判断日志是否应被抑制，避免重复和噪音刷屏。
	private shouldSuppressLog(logEntry: UnifiedLogEntry): boolean {
		const logKey = this.createLogKey(logEntry);
		if (logKey.length === 0) {
			return false;
		}

		const now = Date.now();
		const lastReportAt = this.logReportAtByKey.get(logKey) ?? 0;
		const throttleWindow = this.isNoiseLog(logEntry) ? BRIDGE_LOG_NOISE_WINDOW_MS : BRIDGE_LOG_DUP_WINDOW_MS;
		if (lastReportAt > 0 && now - lastReportAt < throttleWindow) {
			return true;
		}

		this.logReportAtByKey.set(logKey, now);
		if (this.logReportAtByKey.size > 800) {
			for (const [key, timestamp] of this.logReportAtByKey.entries()) {
				if (now - timestamp > BRIDGE_LOG_NOISE_WINDOW_MS * 2) {
					this.logReportAtByKey.delete(key);
				}
			}
		}

		return false;
	}

	/**
	 * 新连接建立前重置握手态。
	 */
	public resetHandshakeState(): void {
		this.hasReceivedDebugSwitch = false;
		this.currentDebugSwitch = { ...DEFAULT_DEBUG_SWITCH };
	}

	/**
	 * 应用服务端下发的调试开关。
	 * @param debugSwitch 调试开关。
	 */
	public setDebugSwitch(debugSwitch: BridgeDebugSwitch): void {
		this.hasReceivedDebugSwitch = true;
		this.currentDebugSwitch = this.normalizeDebugSwitch(debugSwitch);

		if (!this.currentDebugSwitch.enableSystemLog) {
			this.pendingLogs.splice(0, this.pendingLogs.length);
			this.logReportAtByKey.clear();
			return;
		}

		if (!this.currentDebugSwitch.enableConnectionList && this.pendingLogs.length > 0) {
			const filteredLogs = this.pendingLogs.filter(logEntry => !bridgeLogPipeline.isConnectionInfoLog(logEntry));
			this.pendingLogs.splice(0, this.pendingLogs.length, ...filteredLogs);
		}
	}

	/**
	 * 追加日志到发送队列。
	 * @param logEntry 日志实体。
	 */
	public enqueue(logEntry: UnifiedLogEntry): void {
		if (!this.currentDebugSwitch.enableSystemLog) {
			return;
		}

		if (!this.currentDebugSwitch.enableConnectionList && bridgeLogPipeline.isConnectionInfoLog(logEntry)) {
			return;
		}

		if (this.shouldSuppressLog(logEntry)) {
			return;
		}

		this.pendingLogs.push(logEntry);
		if (this.pendingLogs.length > BRIDGE_LOG_QUEUE_LIMIT) {
			this.pendingLogs.splice(0, this.pendingLogs.length - BRIDGE_LOG_QUEUE_LIMIT);
		}
	}

	/**
	 * 尝试把待发日志派送到服务端。
	 * @param transport 传输层实例。
	 */
	public flushToTransport(transport: LogReportTransport | undefined): void {
		if (!this.hasReceivedDebugSwitch || this.flushing || !transport || this.pendingLogs.length === 0) {
			return;
		}

		this.flushing = true;
		try {
			while (this.pendingLogs.length > 0) {
				const nextLog = this.pendingLogs[0];
				transport.reportLog(nextLog);
				this.pendingLogs.shift();
			}
		}
		catch {
			// 发送失败时保留队列，等待后续重连再补发。
		}
		finally {
			this.flushing = false;
		}
	}
}
