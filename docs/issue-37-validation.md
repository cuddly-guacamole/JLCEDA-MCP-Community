# Issue #37：PCB 自动布线实机验证

2026-09-25 在嘉立创 EDA 专业版 3.2.181（运行时 `pro-api/0.3.15`）验证。先确认测试工程 `MCP测试` 的原 PCB `PCB1_1`（UUID `7c12ce155d1051fc`），再用官方 `dmt_Pcb.copyPcb` 生成独立副本 `PCB1_2`（UUID `7a0b6da39ad53e2c`）。运行前活动 Bridge 客户端的文档 UUID 指向副本。

副本有 27 个网络，原 Issue 中的 `UART_TX` 不存在，因此改用副本现有的 `VIN_RAW` 作单网络测试。测试前该网络长度为 0，有 6 个关联图元；严格 PCB DRC 返回 0 项。调用如下：

```json
{"apiFullName":"eda.pcb_Document.autoRouting","args":[{"nets":["VIN_RAW"]}],"timeoutMs":120000}
```

EDA API 直接抛出 `RPC Call autoRouting Timed Out`，没有返回 `IPCB_AutoRoutingResult`。调用后 `VIN_RAW` 长度仍为 0、6 个关联图元 ID 未变、网络总数仍为 27、严格 DRC 仍为 0 项。随后按副本 UUID 调用 `dmt_Pcb.deletePcb`；删除造成当前 Bridge 连接切换，故以重新连接后的 `getPcbInfo` 与工程 PCB 清单核对：副本已不存在，原 PCB `PCB1_1` 仍存在且是清单中唯一 PCB。

本次按 [autoRouting 方法示例](https://prodocs.lceda.cn/cn/api/reference/pro-api.pcb_document.autorouting.html) 使用 `nets`，但官方 [IPCB_AutoRoutingProps 接口](https://prodocs.lceda.cn/cn/api/reference/pro-api.ipcb_autoroutingprops.html) 和锁定的 `@jlceda/pro-api-types@0.4.15` 均声明 `RoutingNets`。因此这次超时不能证明指定网络筛选是否生效。原 Issue 的 62 网络 PCB 已使用 `RoutingNets:["UART_TX"]`，仍立即返回全部网络失败；正确字段本身没有解决原生失败。下一次实机测试应使用 `RoutingNets`，并对照调用前后的全部布线图元、网络长度与 DRC；Issue #37 继续开放。
