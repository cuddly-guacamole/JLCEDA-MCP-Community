# MCP Bridge 社区版

## 2.3.2

本版本以共享 `contracts/bridge-contract.json` 集中维护 Bridge 工具路由、内部交互路由、超时策略和消息字段契约。处理器注册表在加载时校验每个处理器都已声明；设置页优先使用 MessageBus 接收状态更新，当 MessageBus 不可用时使用持久化最新快照轮询回退。`JLCEDA_BRIDGE_TOKEN` 仍为可选配置。

Bridge 会记录任务开始、完成、返回失败、异常和超时的结构化日志，包含工具名、路由、可用的 EDA API 名称、请求 ID、执行阶段以及版本与构建日期水印。菜单“查看调试日志”展示最近 100 条简略报告并隐藏异常堆栈；扩展本地存储保留最近 200 条完整日志。清空日志后，其他已打开页面的后续读取不会恢复旧记录。

配套的 MCP Server 2.3.2 提供连接失联后的写入诊断和同图页恢复回读，并公开原理图导线预览、创建及 NetPort 操作。

交互放置检查可能清理完全重叠的重复器件。若清理或位号恢复的结果不明，`commitUnknown:true` 会隔离后续写入；恢复时通过 `api_invoke` 调用 `eda.sch_PrimitiveComponent.getAllPrimitiveId`，传入 `args:[null,false]` 和 `includeCompleteSchematicComponentIds:true`，可获取不截断的当前图页 `schematicComponentIds`、`schematicComponentStates`（ID 与位号）及数量，供 Server 核对原图页。

## 2.1 PCB 工具

`schematic_layout_check` 读取结构化原理图图元并返回稳定 primitive ID、估算矩形、碰撞类型/严重度、密集区域和能力缺失说明。`mode: "fix"` 配合 `confirm: true` 时仅应用属性文本建议位置。

`schematic_connectivity_action` 在创建导线前检查与现有导线的电气接触，并要求明确列出允许接触的导线 ID。新导线的 `line` 最多包含 512 个数（256 个坐标点），不会限制读取图页上已有导线。检查网络名时会读取当前图页普通 NetLabel 的 `NET` 属性；父 ID 对应导线的属性按导线关联，父 ID 为空且坐标有效的属性按坐标检查。没有连接点的纯十字交叉不算接触。写入后回读导线 ID 和几何，若 EDA 改写了未允许的导线则报告提交状态不明。NetPort 使用当前图页图元的 `setState_X/Y().done()` 移动并回读确认，也可新建层次图端口并返回当前页目标网络的引脚回读。原生写入超时或写入后图元回读失败时返回 `commitUnknown: true`，后续写入等待 Server 受控恢复；前者须重启原 EDA 宿主。恢复时 `schematic_read` 可选 `includeConnectivityPrimitives:true`，返回未截断的当前页导线 ID/几何、NetPort 与 NetFlag 的 ID/网络/坐标、NET 属性和语义网表；图页切换或读取失败会拒绝回读。底层 EDA API 没有提供原子回滚，导线和端口写入后仍需复查完整网表。

`pcb_connectivity_action` 可在指定网络上创建 PCB 直线走线或通孔。`line_create` 需要 `net`、`layer`、`startX/startY`、`endX/endY` 和 `lineWidth`；`via_create` 需要 `net`、`x/y`、`holeDiameter` 和 `diameter`，单位为 EDA 当前画布数据单位。默认先确认网络已存在；明确传入 `allowNewNet:true` 可在独立 PCB 上创建新网络。直线目标层必须是已启用、未锁定的 `SIGNAL` 或 `PLANE` 铜层。写入后使用原生单 ID 查询核对网络和几何；原生调用超时、缺少返回 ID 或回读失败时报告 `commitUnknown:true`，等待受控恢复核对 PCB 布线状态后再写入。

`bridge_select_client` 在已连接的 EDA 页面客户端之间选择 MCP 路由目标。显式选择待命页前会进行约 1.5 秒双向队列探活；旧扩展不支持该选择流程，请先升级 Bridge。它不会切换同一个 EDA 进程中的可见标签页；如需在进程内切换标签页，请通过 `api_invoke` 调用 `eda.dmt_EditorControl.activateDocument(tabId)`。

Server 通过 `bridge_recover_client action=recover` 建立受控恢复会话后，Bridge 会等待底层 EDA Promise 结束再创建新运行时世代及全新 `clientId`；请求本身不能取消 EDA Promise。Promise 持续挂起或 PCB `autoLayout` 返回提交状态未知时，在建立恢复会话后关闭并重启原 EDA 宿主，再用恢复会话后的新连接核对目标图页并执行只读回读；普通掉线自动重连保留旧 `clientId`，不会解除写隔离。所有写任务在执行时上报可用的文档、项目与图页身份；提交状态不明时，Bridge 在结果回传前阻断本机后续写任务。完整安全恢复要求 Bridge 与 Server 均为 2.3.2；2.3.1 Bridge 仍可连接，但其页面写入若缺少执行时身份，2.3.2 Server 会保留隔离。原理图当前页器件查询推荐 `getAllPrimitiveId` 或 `getAll` 搭配 `args:[null,false]`；无参数调用仍兼容。PCB 器件回读可用无参数的 `eda.pcb_PrimitiveComponent.getAll`。隔离期间 Bridge 可处理只读查询，但其结果在原调用结束前只是暂时快照；写入仍被阻止。

PCB 自动布局启动时，Bridge 会采集实际 PCB 身份并发送给 Server；若启动与执行之间切换图页，则取消调用。无参数 `eda.pcb_PrimitiveComponent.getAll` 的普通 `result` 保留原有组件字段；传入 `includeCompletePositions:true` 时另返回不截断的 `componentPositions` 和 `componentCount`，供布局前后与恢复期比较。

PCB `autoRouting` 原生 RPC 超时会返回提交状态未知，旧宿主持续隔离写入；返回 `success:true` 但部分网络失败时也明确报告未完成。对 PCB 的直线、圆弧、折线、过孔调用无参数 `getAll` 并设置 `includeCompleteRouting:true`，会额外返回不截断的 `routingPrimitives`，包含图元 ID、网络、层与几何。Server 受控恢复会在重启原宿主后读取四类图元及全部网络长度，确认仍在执行时的同一 PCB 后才解除隔离。

PCB `import_changes` 打开原生确认对话框后，Bridge 和 Server 均暂停写入，只读查询可继续。用户在 EDA 点击应用修改或取消并确认对话框关闭后，从 `bridge_clients` 取得 `requestId`，调用 `bridge_recover_client action=resolve_import`，设置 `confirm:true` 和对应的 `resolution`。Server 核对同一 PCB 并完整回读器件与网络后发出解除指令。底层 API 不提供对话框完成事件；无法确认时先建立 `action=recover` 会话，重启原 EDA 宿主，再用新 Bridge 客户端执行 PCB 回读。

2.1 版本新增 `schematic_document_action`，用于受限地检查原理图坐标/区域、选中对象、图元、导航、保存和导入。

`schematic_document_action` 与 `pcb_document_action` 的纯查询和画布导航不修改设计数据，可在写入隔离期间使用；改变选择状态、飞线计算、保存和导入仍被阻断。

`schematic_pages_manage` 是受确认保护的页面工作流，可创建、复制、重命名或完整重排原理图页面。重排会使用重新读取的 EDA 页面对象验证完整 UUID 集合和最终顺序；不提供页面删除。写任务在读取当前页面身份期间若失去活动租约，会在调用 EDA 修改 API 前停止。

`eda_context` 在已安装的 EDA 提供 0.4.15 API 时返回客户端版本、连接模式、编辑器版本、编译日期和当前画布数据单位。

`eda_canvas_snapshot` 可在不改变文档或视图的情况下返回受限的当前画布图像。

`workspace_query` 读取当前工作区/团队以及受限的可访问工作区、团队、工程和文件夹列表。

`design_source_export` 读取当前文档或封装源文件的受限预览；完整源文本需要明确授权且受字节数限制。

`design_archive_export` 默认返回原生当前工程/当前文档归档元数据，只有明确请求时才包含受限的 Base64 数据。

`library_preview` 将符号和封装资源渲染为受限的 MCP 图像，`library_classification_query` 返回受限的官方库分类树。

`project_info` 可选返回当前工程受限的 Board 和 Panel 清单。

`pcb_document_action` 还支持 PCB 鼠标位置、明确选择以及受限的图元 ID/类型/BBox 查询。

2.1 版本新增 `pcb_drc_check`、`schematic_drc_check`、`pcb_net_query`、`pcb_constraints_query`、`pcb_layer_query`、`pcb_realtime_drc`、`pcb_document_action`、`project_info`、`netlist_compare`、`design_compare`、`manufacture_export`、只读的 `manufacture_templates_query`、`library_sources` 和 `library_search`。网络查询支持完整详情、仅名称列表、官方 `getNet` 精确读取以及精确网络的长度/颜色/图元分析。`component_select` 和设备 `library_search` 支持精确的 0.4.15 属性查询；设备搜索还支持官方单个/批量 LCSC C 编号映射和精确 UUID 获取，符号、封装、3D 模型、可复用模块、Panel 库和仿真模型搜索使用各自支持的 API。仿真模型读取不可用，因为官方 `get` API 需要私有部署。PCB BOM 导出可选择 `manufacture_templates_query` 返回的模板，原理图 BOM 导出可选择装配变体。制造导出包含官方飞针测试文件。`pcb_constraints_query` 返回结构化规则和约束组。`pcb_document_action` 可检查 PCB 坐标、选中/区域图元、过滤器和画布状态，也可导入 Base64 JSON/SES、控制导航/飞线计算，并执行明确请求的受限布线清理。PCB 专用自动布局/自动布线 MCP 工具仍未启用；目标 EDA 的 BETA API 可经 `api_invoke` 调用，但应以器件位置、导线、过孔和 DRC 读回确认结果。

`pcb_constraints_manage` 是约束组的受确认保护写入工具，支持单个网类、差分对、等长组和 Pad 对组修改，只校验当前操作相关字段并读取验证受影响项目；不支持批量替换规则配置。

当前版本会拒绝显式传入的空 UUID 选择；网络标签修改同时支持普通标签和电源/地网络标识。

> 本扩展不是嘉立创官方插件，也不代表嘉立创或原项目维护者。

本扩展基于 [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP)
项目中的 **MCP Bridge** 改进，由社区独立维护。社区版使用独立的原生 MCP
Server，通过本机 WebSocket 与嘉立创 EDA 专业版连接，不再依赖 VS Code / Cursor
侧的 MCP Hub 扩展。

主要改进包括原生 MCP 协议、多客户端页面选择、Bridge 凭据保护、语义级原理图读取、
器件放置和网络标签等工具。

当活动页面任务已确认卡死时，MCP 客户端可通过 `bridge_select_client` 的 `force: true`
切换到新的就绪页面。切换会使旧租约的未开始任务失效，但不会取消已经在 EDA 内执行的 API 调用。

## 功能演示

![MCP Bridge 功能演示：原理图读取、器件放置和网络标签修改](images/feature-demo.png)

上图展示 Bridge 已连接时的典型工作流：MCP 客户端读取原理图、放置器件并修改网络标签，
嘉立创 EDA 页面负责执行和呈现对应操作。图片为功能流程示意，实际界面以当前 EDA 版本为准。

链路：嘉立创 EDA -> 本机 WebSocket (Bridge) -> 原生 MCP Server -> MCP 客户端。

- 社区仓库：https://github.com/hs150521/JLCEDA-MCP-Community
- 上游项目：https://github.com/sengbin/JLCEDA-MCP
- 社区联系邮箱：hs150521@proton.me

内置专用工具：

**基础工具**

- `schematic_read`：读取当前原理图页面的完整电路语义快照，包含器件列表、引脚网络连接关系与 DRC 检查结果。
- `schematic_review`：读取全工程所有原理图页面的网表文件，覆盖多页电路，适合全局审查、BOM 核查与跨页信号追踪。
- `component_select`：搜索器件候选项并返回确认结果；可直接输入 LCSC C 编号以查询已关联的 EasyEDA 器件。
- `component_place`：引导放置已确认的器件列表。
- `netlabel_place`：电源/地网络创建对应网络标识，其他信号创建普通网络标签。

**透传 EDA API 工具（可选，需在服务端侧边栏开启）**

- `api_index`：列出所有可用的 EDA API 模块名称。
- `api_search`：按关键词搜索具体 API 方法及参数说明。
- `eda_context`：读取当前 EDA 页面的上下文信息。
- `api_invoke`：直接调用任意 EDA API 并返回结果。

## 安装

必须同时安装 EDA Bridge 和原生 JLCEDA MCP Server。本社区版不依赖旧版 MCP Hub。

### 1. EDA Bridge

从同一 Release 下载并在嘉立创 EDA 专业版扩展管理器中安装 `mcp-bridge-community-2.3.2.eext`，重启 EDA，然后打开原理图或 PCB 页面。

### 2. 原生 MCP Server

从同一 Release 下载匹配的 `jlceda-mcp-server-2.3.2.tgz`，执行：

```powershell
npm install --global .\jlceda-mcp-server-2.3.2.tgz
```

安装后的命令为 `jlceda-mcp`。源码构建及其他客户端配置见[原生 MCP 安装说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)。

Codex 可运行：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 -- jlceda-mcp
```

Claude Desktop、Claude Code、Cursor 等客户端应将 `jlceda-mcp` 注册为本地 STDIO MCP Server。

### 3. Bridge 地址

默认地址为 `ws://127.0.0.1:8765/bridge/ws`。若设置 `JLCEDA_BRIDGE_TOKEN`，EDA 设置页地址必须携带同一个 token。不要公开 token 或包含 token 的截图。

## 安全、兼容性与已知限制

- Server 仅监听 `127.0.0.1`；推荐配置 Bridge Token。
- MCP 工具能够修改当前工程。操作前请保存工程，并审查 AI 提议的写操作。
- `api_invoke` 是可选的 API 透传能力，只应在信任的 MCP 客户端中启用。
- 已在嘉立创 EDA 专业版 3.2.181 上测试；其他 3.x 版本需自行验证。
- `createNetLabel` 从 EDA v4 起提供。Bridge 在 3.x 上对普通网络标签立即返回 `EDA_VERSION_UNSUPPORTED` 和 `commitStatus: not_started`，避免进入超时隔离；电源和地网络标识仍可使用。若更新版 EDA 的底层调用超时，仍需恢复回读后才能继续写入。
- 扩展只在原理图或 PCB 页面建立 Bridge 连接。

## 状态说明

连接设置页面展示两行状态，每秒自动刷新：

- **第一行（桥接状态）**：活动页面显示"已连接"；待命页面显示"当前活动客户端：xxx"；连接失败显示"连接失败"。
- **第二行（WebSocket 状态）**：正在连接时显示"连接中"；连接成功后显示"当前客户端：xxx"；连接失败时显示具体错误原因。

仅在原理图或 PCB 页面可连接，连接失败后系统会自动重试。

## 交互与注意事项

1. 写操作前保存工程，并确认活动项目和页面正确。
2. `component_place` 会启动 EDA 内的交互放置；每次点击后按 Esc 或右键结束当前器件放置，批次才会继续。会话进行中，Bridge 会阻止其他写任务，但允许放置状态轮询、关闭会话、读取和导线预览。启动超时、失联或放弃会话后，若 EDA 仍可能处于交互放置模式，写入继续受阻，直至按 Esc 或右键退出；原生调用结果未定还须重启原宿主并完成受控回读。结果包含新增图元 ID；若一次点击产生多个图元或放置期间切换图页，先核对并处理，不要直接重试。交互放置和 `component_place_auto` 都会尝试恢复本次放置使已有器件改变的位号，保留完整 `otherProperty` 并在修改后回读当前图页；结果通过 `restoredDesignators` 报告已恢复位号，`designatorChanges` 仅列出最终仍有变化的位号。旧位号被占用、属性无法核实或回读失败时停止后续放置并报告实际明细；修改结果不明时阻止继续写入。
3. 多个 EDA 页面同时连接时，应先枚举客户端并明确选择目标页面。
4. 修改端口或 token 后，必须同步更新 MCP Server 环境变量与 Bridge 地址。
5. 普通网络标签创建失败时不要改用电源网络标识代替；3.x 请使用支持的导线操作，4.x 请查看 Bridge 调试日志。
6. 状态异常时先关闭旧版 MCP Hub，再重启 AI 客户端与 EDA Bridge。

`api_invoke` 中的 `eda.sch_PrimitiveComponent.modify` 和 `delete` 做兼容处理：修改时省略 `otherProperty` 会保留原值；传入图元 ID 数组删除时会逐项执行，跨当前原理图的全部图页核对，并返回 `deletedIds`、`failedIds`。删除后的图元读回失败会停止后续删除，返回 `commitUnknown: true`、`readbackRequired: true` 及待核对的 ID；此时应先完成受控恢复，不要直接重试。
## 常见问题

### 聊天里看不到工具怎么办？

请在聊天客户端确认该 MCP 服务已被信任，并检查工具开关是否开启。

### AI 读不到当前图纸内容怎么办？

EDA 页面可能未桥接成功，请回到连接设置页确认连接状态是否正常。

### 保存地址后仍无法连接？

请确认原生 MCP Server 已安装并由 AI 客户端启动，且端口、token 与 Bridge 地址一致。

### 扩展已启用，但提示“未授予外部交互权限”？

在嘉立创 EDA 专业版 V3 中打开“高级 → 扩展管理器 → 已安装”，点击“MCP Bridge 社区版”，启用“外部交互”权限，再重启 EDA。扩展的“已启用”状态不会自动授予这项权限。操作入口见[嘉立创官方指南](https://prodocs.lceda.cn/cn/api/user-guide/using-extension.html)。

## 许可证

本扩展采用 [Apache License 2.0](LICENSE) 许可证。
数据处理说明见 [PRIVACY.md](PRIVACY.md)。
