# Issue #37：PCB 自动布线实机验证

2026-09-25 在嘉立创 EDA 专业版 3.2.181（运行时 `pro-api/0.3.15`）验证。先确认测试工程 `MCP测试` 的原 PCB `PCB1_1`（UUID `7c12ce155d1051fc`），再用官方 `dmt_Pcb.copyPcb` 生成独立副本 `PCB1_2`（UUID `7a0b6da39ad53e2c`）。运行前活动 Bridge 客户端的文档 UUID 指向副本。

副本有 27 个网络，原 Issue 中的 `UART_TX` 不存在，因此改用副本现有的 `VIN_RAW` 作单网络测试。测试前该网络长度为 0，有 6 个关联图元；严格 PCB DRC 返回 0 项。调用如下：

```json
{"apiFullName":"eda.pcb_Document.autoRouting","args":[{"nets":["VIN_RAW"]}],"timeoutMs":120000}
```

EDA API 直接抛出 `RPC Call autoRouting Timed Out`，没有返回 `IPCB_AutoRoutingResult`。调用后 `VIN_RAW` 长度仍为 0、6 个关联图元 ID 未变、网络总数仍为 27、严格 DRC 仍为 0 项。随后按副本 UUID 调用 `dmt_Pcb.deletePcb`；删除造成当前 Bridge 连接切换，故以重新连接后的 `getPcbInfo` 与工程 PCB 清单核对：副本已不存在，原 PCB `PCB1_1` 仍存在且是清单中唯一 PCB。

本次按 [autoRouting 方法示例](https://prodocs.lceda.cn/cn/api/reference/pro-api.pcb_document.autorouting.html) 使用 `nets`，但官方 [IPCB_AutoRoutingProps 接口](https://prodocs.lceda.cn/cn/api/reference/pro-api.ipcb_autoroutingprops.html) 和锁定的 `@jlceda/pro-api-types@0.4.15` 均声明 `RoutingNets`。因此这次超时不能证明指定网络筛选是否生效。原 Issue 的 62 网络 PCB 已使用 `RoutingNets:["UART_TX"]`，仍立即返回全部网络失败；正确字段本身没有解决原生失败。下一次实机测试应使用 `RoutingNets`，并对照调用前后的全部布线图元、网络长度与 DRC；Issue #37 继续开放。

## 同板后续对照

随后在 `MCP测试` 的 `PCB1_2` 上，对现有 `PMOS_PULL` 网络使用正确的 `RoutingNets:["PMOS_PULL"]`。先删除该网的一条直线导线，确认只剩 2 个焊盘、网络长度为 0、严格 DRC 有 2 项。调用原生 `eda.pcb_Document.autoRouting` 后约 1.3 秒抛出 `RPC Call autoRouting Timed Out`；紧接着只读回查发现该网新增 1 条 Track、网络长度为 65.677034，严格 DRC 降至 0 项。这证明原生超时不能当作“没有布线”：至少在这次同板对照中，布线已经可见。

回查发生在超时后，不能据此证明原生后台调用已经结束，也不能证明 `RoutingNets` 只影响了请求网络。新的 Bridge 在显式指定最多 3 个网络时，会在调用前后读取这些网络的布线图元 ID 和长度，超时结果返回 `routingObservation`（`changed`、`unchanged` 或 `unavailable`），同时继续设置 `commitUnknown:true`、`retryBlocked:true`。这份即时观察只是暂时快照；仍需重启原 EDA 宿主，再用全新 Bridge 客户端完整回读原 PCB 的四类布线图元和全部网络，才能解除写入隔离。原 Issue 的 62 网络立即失败尚未解决，Issue #37 继续开放。

开发扩展的后续联调还观察到延迟提交：原生超时后的即时 `routingObservation.status` 为 `unchanged`，当时目标网络仍只有 2 个焊盘；数分钟后同网重新出现第 3 个图元，长度达到约 65.677。因而 `unchanged` 只能表示回读时暂未看到变化，不能据此重试。该次联调使用的 MCP Server 进程启动早于磁盘上 Server 构建更新，曾错误地接受仅 `/context` 的恢复回读；这不是完整布线验证，后续须重启到当前 Server 构建再验证恢复流程。

`routingObservation.nets` 每项直接给出 `beforeLength`、`afterLength`、`beforeRoutingPrimitiveCount` 与 `afterRoutingPrimitiveCount`；新增和移除的图元 ID 分别位于 `routingObservation.addedRoutingPrimitiveIds`、`routingObservation.removedRoutingPrimitiveIds`，两者均按网络名索引。这些字段保持在 Bridge 可完整序列化的层级，MCP 客户端可以直接读取。
