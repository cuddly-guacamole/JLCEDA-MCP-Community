# JLCEDA MCP Server

## 2.3.2

本版本使用共享 Bridge 路由清单，增加内部请求超时、重复 `requestId` 检查、消息大小限制和有限挂起请求队列。`JLCEDA_BRIDGE_TOKEN` 仍为可选配置。

工具分发异常和 Bridge 上报的结构化诊断日志会输出到 Server 的 stderr。分发异常记录工具、Bridge 路由、可用的错误码与异常堆栈，并附带版本及构建日期水印；构建日期在打包时固定。

`component_select` 的关键词与精确属性搜索、`design_compare` 的网表/原理图/PCB 比较现在都能通过 Server 的输入校验并进入 Bridge。

`component_place` 等待用户按 Esc 或右键退出当前放置模式后才启动下一件；完全重叠的重复图元经核对后清理，并透传新增与清理的图元 ID。已有器件位号被 EDA 改动时，会保留 BOM 属性并尝试恢复原位号，结果列于 `restoredDesignators`；未恢复、失联或超时则停止批次，不自动重试未知是否已提交的操作。

`component_place_auto` 按坐标逐件创建；若 EDA 改变已有器件或本批次此前放置器件的位号，会保留 BOM 属性并尝试一次恢复。恢复失败时停止后续放置，返回位号变化及已放置器件的当前位号。

`bridge_clients` 和 `bridge_select_client` 用于在已连接的 EDA 页面客户端之间切换 MCP 路由。显式选择待命客户端前，Server 会发送短时双向探活，并等待其串行任务队列回传确认；探活失败不会更改活动客户端或租约。旧版 Bridge 未声明探活能力时仍可连接，但须升级后才能显式选中待命页面。它们不会切换同一个 EDA 进程中的可见标签页。如需在进程内切换标签页，请通过 `api_invoke` 调用 `eda.dmt_EditorControl.activateDocument(tabId)`。

`bridge_recover_client` 用于不可取消 EDA 修改超时后的受控恢复。先从 `bridge_clients` 取得具体 `requestId`，再以 `action=recover` 建立恢复会话。若原 EDA Promise 一直挂起，此后须重启原 EDA 宿主以终止旧调用，并重新打开目标图页；保持 MCP Server 运行以保留诊断。原调用正常结束时 Bridge 会自行重连。等待原 Bridge 连接断开、恢复会话建立后的新 Bridge 连接就绪，再用全新 `clientId` 做身份校验和只读 `action=readback`。普通掉线自动重连会沿用旧 `clientId`，即使 WebSocket 已更换也不能用于本次回读；建立恢复会话时已连接的其他客户端同样不能通过重连解除隔离。当前页绑定的写入必须有任务执行时的 `pageUuid`，不能用旧心跳或手填 `expectedPageUuid` 代替。跨页器件删除需以全工程 `schematic_review` 回读；其他非页面操作应显式给出目标 `expectedDocumentUuid` 或 `expectedProjectUuid`，已确认签名的工程改名 API 会使用其参数中的目标工程 UUID。完整安全恢复要求 Bridge 与 Server 均升级到 2.3.2；2.3.1 Bridge 可正常连接，但旧版页面写入缺少执行身份时会保留隔离。回读完成前，EDA 写操作都会被阻止；普通只读查询可执行，但原调用挂起时结果只是暂时快照。`schematic_layout_check` 的 `mode: "fix"` 按写操作隔离。

PCB `import_changes` 返回 `pending_confirmation` 后，Server 将其列为全局写入阻断诊断。用户在原 EDA 对话框应用或取消并确认关闭后，使用诊断中的 `requestId` 调用 `bridge_recover_client`，传入 `action:"resolve_import"`、`confirm:true`、`resolution:"applied"` 或 `"cancelled"`。Server 核对原连接及 PCB 文档/图页，完整读回器件和网络；Bridge 收到同页解除确认后才恢复写入。只读查询在此期间仍可用，但 EDA API 不提供确认框完成事件，读回本身不能证明对话框已关闭。无法确认时以 `action:"recover"` 建立恢复会话，重启原 EDA 宿主，再用全新连接、`hostRestartConfirmed:true`、无参数 `eda.pcb_PrimitiveComponent.getAll` 做 `action:"readback"`；Server 还会分页读取完整网络名称。

恢复时必须从 `bridge_clients` 选择具体超时写操作的 `requestId`；`readbackPath` 与 `readbackPayload` 始终只能描述只读操作，恢复目标客户端在首次回读后锁定。多个未解决的超时写操作会继续保持写阻断，直到各自收到迟到结果或完成受控恢复；未确认完成的写诊断不会因 TTL 自动放行写入。

已开始的写任务若因页面失联、心跳停滞或 MCP 调用方断开而无法确认完成，也会留下同样的诊断；`uncertaintyReason` 标明失联原因。重连等待期届满不会自动解除写阻断。

原理图当前页器件 ID 回读建议使用 `readbackPath: "/bridge/jlceda/api/invoke"` 和 `readbackPayload: {"apiFullName":"eda.sch_PrimitiveComponent.getAllPrimitiveId","args":[null,false]}`。`getAllPrimitiveId` 和 `getAll` 的 `args:[null,false]` 被严格识别为当前页只读查询；无参数调用继续兼容，但部分 EDA 版本可能混入其他图页。`allSchematicPages: true` 不适合当前页恢复判断。`bridge_clients` 的 `ready` 依据最近心跳判定，`lastHeartbeatMsAgo` 可用于识别仅有其他消息但心跳已停的客户端。

PCB 器件位置回读可将 `readbackPath` 设为 `/bridge/jlceda/api/invoke`，`readbackPayload` 设为 `{"apiFullName":"eda.pcb_PrimitiveComponent.getAll","args":[]}`；Server 会自动请求不截断的 `componentPositions`。布局前也可直接调用 `api_invoke` 并传入 `includeCompletePositions:true` 取得全量位置，同时保留通用 `result` 字段。若原操作是 `eda.pcb_Document.autoLayout` 且提交状态未知，先以 `action=recover` 建立会话，再关闭并重启原 EDA 宿主，保持 MCP Server 运行；旧 Bridge 连接断开、恢复请求后的新客户端连接同一 PCB 后，才执行这一完整位置回读。仅查 `/context` 不会解除写入阻断。恢复期仅放行此 PCB 方法的无参数形式；带图层或锁定筛选参数的调用仍被隔离。若任务启动时未取得实际 PCB UUID，不能用过期的心跳图页或自行填写的 UUID 解除自动布局隔离。

PCB `autoRouting` 原生 RPC 超时也会留下写入隔离诊断。先执行 `action=recover`，再关闭并重启原 EDA 宿主；全新 Bridge 客户端打开任务执行时的同一 PCB 后，调用 `action=readback`，设置 `hostRestartConfirmed:true`、`readbackPath:"/bridge/jlceda/api/invoke"`、`readbackPayload:{"apiFullName":"eda.pcb_PrimitiveLine.getAll","args":[]}`。Server 会在分段读取前后核对 PCB 身份，自动完整读回直线、圆弧、折线、过孔的图元 ID、网络、层与几何，以及全部网络长度。任何一段失败都继续阻断写入。直接调用四类无参数 `getAll` 时可传 `includeCompleteRouting:true` 获取相同的不截断图元快照。

`pcb_connectivity_action` 提供 `line_create` 与 `via_create`。调用前用 `pcb_net_query` 核对网络名，并用 `pcb_layer_query` 选择启用且未锁定的铜层（SIGNAL 或 PLANE）；独立 PCB 需要创建新网络时显式传 `allowNewNet:true`。坐标和尺寸使用当前 PCB 数据单位，导线宽度、过孔孔径与外径都必须给正值。原生创建返回后会回读图元；若结果未确认，Server 隔离后续写入，并要求新 Bridge 客户端对同一 PCB 完整回读直线、圆弧、折线、过孔和网络。诊断的 `hostRestartRequired:true` 表示原生调用可能尚未结束，恢复前还必须重启原 EDA 宿主并传 `hostRestartConfirmed:true`；若原生调用已结束、只是回读失败，则不要求宿主重启。回读参数与上方自动布线相同。

Bridge 客户端超时会返回带 `BRIDGE_TASK_TIMEOUT` 标记的结果；Server 会将该结果纳入同一受控恢复诊断流程，不要求必须等 Server 自身的备用计时器触发。

`schematic_connectivity_action` 的导线或 NetPort 写入返回 `commitUnknown: true` 时，即使按时收到结果，Server 也会建立未确认写入诊断并阻止后续写入；这包括原生写入成功但紧接的图元回读失败。Server 超时后的迟到结果同样保留诊断。导线创建、NetPort 创建或移动必须用 `bridge_recover_client action=readback` 指定 `readbackPath:"/bridge/jlceda/schematic/read"`、`readbackPayload:{"includeConnectivityPrimitives":true}`；Server 核对原图页完整导线 ID/几何、NetPort ID/网络/坐标、NET 属性和语义网表。读回失败继续隔离，只查 `/context` 不会解除。

## 工具说明

`schematic_layout_check` 对当前原理图执行保守的符号/引脚/属性/导线矩形碰撞检查，并显式报告属性几何和页面边界能力是否可用。修复模式需要 `confirm: true`，只移动属性文本，不改变电气连接。

`schematic_connectivity_action` 提供 `wire_preview`、`wire_create`、`netport_create` 和 `netport_move`。新导线的 `line` 最多包含 512 个数（256 个坐标点）。先预览导线与现有导线的电气接触，再把确实要连接的导线 ID 传给 `allowedWireIds`；没有连接点的纯十字交叉不算接触，不同已命名网络的接触会被拒绝。创建后返回受影响导线 ID，仍需复查网表。NetPort 在当前图页创建或移动并回读图元；新建时还返回目标网络的引脚列表。NetPort 是层次图端口，可用于同页连接，不应当作跨页连接标识。

`component_place` 的放置检查可能清理与已有图元完全重叠的重复副本；该检查按写操作执行，超时或失联后需按写入恢复流程处理。

`component_place` 检查或 `component_place_auto` 若返回 `commitUnknown:true`，恢复回读必须调用 `eda.sch_PrimitiveComponent.getAllPrimitiveId`，传 `args:[null,false]`；Server 会追加 `includeCompleteSchematicComponentIds:true`，核对当前图页及不截断的 `schematicComponentIds`、`schematicComponentStates`（ID 与位号）和数量，不能只用 `/context` 或网表解除隔离。诊断有 `hostRestartRequired:true` 时，须先重启原 EDA 宿主。

Server 提供 `schematic_document_action`，用于受限地检查原理图坐标、选中对象、区域图元、过滤器和鼠标位置，并执行视图导航、图元选择、属性读取、保存和变更导入。

`schematic_document_action` 和 `pcb_document_action` 的纯查询及画布导航可在写入隔离期间使用；改变选择状态、飞线计算、保存和导入仍受写入隔离约束。

`schematic_pages_manage` 只有在 `confirm: true` 时才会创建、复制、重命名或完整重排页面。重排必须提供每个页面 UUID，Bridge 会重新读取页面对象并验证最终顺序；不提供删除功能。页面操作可指向非当前图页；提交状态未知时，用无参数 `eda.dmt_Schematic.getAllSchematicPagesInfo` 读回完整目录，并核对目标页面或原理图归属，当前图页的 `/context` 回读不会解除隔离。

`eda_context` 在客户端支持时返回客户端版本、连接模式、编辑器版本、编译日期和当前画布数据单位。`eda_canvas_snapshot` 可在不改变文档或视图的情况下返回受限的画布图像。

`workspace_query` 查询当前工作区、团队以及受限的工程和文件夹列表。`design_source_export` 和 `design_archive_export` 分别读取受限的源文件预览和原生设计归档元数据；完整文本或 Base64 数据都需要明确授权并受大小限制。

`library_preview` 可生成符号/封装预览图，`library_classification_query` 可浏览官方库分类树。`project_info` 可选返回受限的 Board 和 Panel 清单。

Server 提供 PCB DRC、网络查询、库搜索、制造查询和受保护的文档操作。设备 `library_search` 支持 0.4.15 精确属性、官方单个/批量 LCSC C 编号映射和精确 UUID 获取；符号、封装、3D 模型、可复用模块和 Panel 库使用各自支持的 API。仿真模型搜索支持 Ngspice/SimulIDE 过滤，但官方模型读取 API 需要私有部署，因此不公开。制造导出包含官方飞针测试文件，PCB 专用自动布局/自动布线 MCP 工具仍未启用；EDA BETA API 可经 `api_invoke` 调用，结果需用器件位置、导线、过孔和 DRC 读回确认。

`pcb_constraints_manage` 是受确认保护的写入工具，用于网类、差分对、等长组和 Pad 对组的窄范围修改，并返回受影响项目的读取验证；不支持批量替换规则配置。

公开的 `timeoutMs` 参数会传递到 WebSocket 请求。EDA 修改超时后，Bridge 会隔离未完成的任务，避免后续请求并发修改；请求排队时间不计入 API 执行超时。

本软件包是 **MCP Bridge 社区版**配套的原生 Model Context Protocol Server，通过 STDIO 与 Codex、Claude、Cursor 等 MCP 客户端通信，再通过仅监听本机的 WebSocket 与嘉立创 EDA 专业版扩展通信。

> 社区维护项目，基于 `sengbin/JLCEDA-MCP` 改进；不是嘉立创官方插件。

## 要求

- Node.js 20 或更高版本
- 嘉立创 EDA 专业版 3.x
- 已安装匹配发布版本中的 MCP Bridge 社区版 `.eext`

## 安装

从 GitHub 发布页下载 `jlceda-mcp-server-2.3.2.tgz`：

```powershell
npm install --global .\jlceda-mcp-server-2.3.2.tgz
Get-Command jlceda-mcp
```

## 配置

默认端口为 `8765`。建议生成随机 Bridge Token，并在 MCP 客户端与 EDA Bridge 设置页使用相同值。

Codex：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 --env JLCEDA_BRIDGE_TOKEN=YOUR_RANDOM_TOKEN -- jlceda-mcp
codex mcp list
```

通用 JSON 客户端：

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "jlceda-mcp",
      "env": {
        "JLCEDA_BRIDGE_PORT": "8765",
        "JLCEDA_BRIDGE_TOKEN": "YOUR_RANDOM_TOKEN"
      }
    }
  }
}
```

EDA Bridge 地址：

```text
ws://127.0.0.1:8765/bridge/ws?token=YOUR_RANDOM_TOKEN
```

不要同时运行旧版 MCP Hub 和本 Server；它们占用同一端口时会导致启动或握手失败。

## 安全

- Server 仅绑定 `127.0.0.1`，不会主动监听局域网接口。
- Token 属于本地 Bridge 凭据，不应提交到仓库或出现在截图、日志和 Issue 中。
- 工具可修改当前 EDA 工程；使用写工具前请保存工程并检查目标页面。
- `netlabel_place` 的普通信号标签需要 EDA v4；在 3.x 中该操作会立即返回未开始，电源和地网络标识仍可使用。
- API 透传工具是可选功能，仅应在受信任的 MCP 客户端中启用。

完整安装、多客户端选择和故障排查说明见[原生 MCP 安装说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)。

当 `bridge_clients` 显示活动页面任务卡死且另一个页面已就绪时，可使用 `bridge_select_client` 并设置 `force: true` 进行恢复。该选项会取消 Server 对旧页面任务的等待并切换租约，但不能取消已经在 EDA 内运行的 API 调用。

## 支持与许可证

- Issue：<https://github.com/hs150521/JLCEDA-MCP-Community/issues>
- 安全报告与联系邮箱：`hs150521@proton.me`
- 隐私政策：[PRIVACY.md](PRIVACY.md)
- 许可证：Apache-2.0
