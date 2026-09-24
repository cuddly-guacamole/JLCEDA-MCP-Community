# 更新日志

## [2.3.2] - 2026-09-25

- `netlabel_place` 工具说明标明普通网络标签需要 EDA v4；EDA 3.x 将直接返回未开始，避免调用不可用的 API。
- `pcb_document_action` 与代理指引标明 PCB 变更导入的原生确认阶段，以及 PCB BETA 自动布局/布线的结果验证步骤。
- 交互式 `component_place` 等待用户退出当前放置模式，只返回退出后仍存在的新增图元 ID；重复图元或超时后停止批次，不自动重试可能已提交的放置。
- `component_place_auto` 检查本批次此前放置的器件位号；后续放置导致位号变化时停止批次，并返回更新后的已放置明细。
- 新增 `schematic_connectivity_action`，提供导线交点预览、需显式允许已有导线接触的创建流程，以及当前图页 NetPort 创建和移动入口。
- 按最近心跳判定 Bridge 客户端是否就绪，并让心跳停滞的连接超时退出；`bridge_clients` 增加 `lastHeartbeatMsAgo`。
- 已开始的写任务若因 EDA 客户端或 MCP 调用方失联而中断，保留未确认修改诊断；重连隔离时间届满仍需恢复回读才能再次写入。
- 恢复隔离期间允许 `getAllPrimitiveId` / `getAll` 以严格的 `args:[null,false]` 查询当前页器件，并可用于受控恢复回读；无参数调用继续兼容，其余 `api_invoke` 仍按写入隔离。
- PCB 恢复期间可用无参数的 `eda.pcb_PrimitiveComponent.getAll` 回读器件位置；带筛选参数的调用继续受隔离。
- `bridge_recover_client` 使用原始超时诊断的图页 UUID 校验新客户端与实际 `/context` 回读；同一文档中的其他原理图页或 PCB 不再能解除当前图页的写入阻断。
- PCB 器件位置回读返回完整的位置、旋转角和位号摘要，不会在多于 120 个器件时截断恢复依据。
- 恢复回读明确失败时继续阻断写入；PCB 自动布局超时后，强制以同板完整器件位置回读恢复，单独查询 `/context` 不会解除隔离。
- Server 与 Bridge 超时先后交错、或 EDA 原生自动布局返回提交状态未知时保留恢复诊断，避免重启 Bridge 后绕过位置回读。
- 原理图导线及 NetPort 的结果若标记 `commitUnknown: true`，按时返回也会建立未确认写入诊断；迟到结果继续保留诊断，避免另一页面提前再次写入。
- 所有未确认写操作的恢复回读均要求原 Bridge 连接已经断开；另一页面的新连接不能在旧原生调用仍运行时提前解除隔离。PCB 自动布局仍须重启原 EDA 宿主并读回全部器件位置。
- 明确恢复顺序：先以 `action=recover` 建立会话，持续挂起或 PCB 自动布局提交未知时再重启原 EDA 宿主，最后使用会话之后的新连接完成 `action=readback`。
- 恢复目标按 WebSocket 连接身份识别新 Bridge，避免新连接与恢复请求落在同一毫秒时被错误拒绝。
- `schematic_connectivity_action` 的导线预览按只读分类，超时或断线不再留下未确认写入诊断。

## [2.3.1] - 2026-09-24

- 工具分发异常输出包含工具、Bridge 路由、错误信息、异常堆栈以及版本与构建日期水印的结构化 stderr 日志；Server 同时输出 Bridge 上报的诊断日志。
- Bridge 任务错误的名称、堆栈、错误码和超时时间可沿 Server 内部转发链保留；构建日期写入打包产物，便于定位实际运行版本。
- 修复 `component_select` 的关键词/属性搜索和 `design_compare` 的三种比较输入在 MCP 输入校验阶段被错误拒绝的问题。

## [2.3.0] - 2026-08-25

- 使用根目录 `contracts/bridge-contract.json` 作为 Bridge 公开工具、内部交互路由、超时策略和协议字段的唯一事实源。
- Server 分发和 Bridge 回包均按共享契约校验；握手协商协议版本 1，并兼容缺少版本字段的旧 Bridge。
- 将 WebSocket 编码、负载上限和 token 比较提取为独立线协议模块，保持 `EdaBridgeServer` 协调 API 不变。

- 使用共享 Bridge 路由清单注册和分发 MCP 工具。
- 增加内部请求超时、重复 `requestId` 检查、消息大小限制和有限挂起请求队列。
- 增强多客户端 Bridge 消息校验，保持可选的本机 token 认证。
- 修复客户端模式内部转发在主 Server 排队期间过早按执行超时失败的问题；辅助 Server 现在等待主 Server 的 `bridge/task-started` 回执后才开始执行超时计时。
- 修复交互式 `component_place` 轮询和关闭控制路径被误判为写操作的问题，避免短暂读取超时触发不必要的恢复隔离。
- 对客户端模式内部转发应用与主 Server 相同的挂起请求上限。
- 修复 Bridge 客户端先于 Server 超时时未创建恢复诊断的问题；超时结果现在携带结构化 `BRIDGE_TASK_TIMEOUT` 标记和超时时间，并进入同一写隔离流程。
- 加固受控恢复：恢复绑定显式超时 `requestId`，拒绝 `layout-check mode=fix` 回读写入，断开源客户端仍可通过隔离诊断恢复；目标客户端断开后可由新连接世代重新绑定，同 ID 重连也会校验连接世代；未确认完成的写诊断不会因 TTL 自动解除写阻断。

- 新增 `bridge_recover_client` 的受控恢复流程：保留超时写操作诊断，要求显式确认、新的 Bridge 运行时、文档身份校验和只读回读；在确认前继续阻止写入并提示修改可能已完成。

## 2.2.2 - 2026-08-25

- 发布与 Bridge 2.1.3 配套的 Server 2.2.2 构建产物，修复 Bridge 客户端先超时场景的受控恢复诊断。
- 修复恢复边界：`schematic_layout_check mode=fix` 被识别为写操作；断开客户端后仍保留恢复会话；多个超时修改分别保留诊断；恢复期间允许只读请求；领域 readback 会额外校验 `context` 身份快照。

## 2.2.1 - 2026-08-24

- 新增 `schematic_layout_check`，提供原理图符号、引脚、属性文本、网络标签和导线的保守几何重叠检查、密集区域报告及确认保护的属性文本修复。

- 发布与 Bridge 2.1.2 配套的 Server 2.2.1 构建产物，并同步中文文档。

- MCP WebSocket 断开时清理挂起的 Bridge 请求，避免失联调用方一直锁定 `bridge_select_client` 直到队列超时。
- 同一页面重新连接后拒绝绑定旧 EDA 套接字的请求，避免旧结果跨越连接代次返回。
- 重新连接的页面在接纳新请求前，按照上一项 EDA 任务的执行窗口进行隔离，避免不可取消的修改操作重叠执行。
- EDA 或 MCP 套接字断开时继续保持隔离，包括仍排在 `bridge/task-started` 之前的任务以及服务端执行超时的任务。
- EDA 以名称键对象返回差分对读回数据时，保留受影响的约束项目。
- 移除不受支持的原理图网络和当前层公共路由，并使用所需的文档 UUID 同步 PCB 保存操作。

## 早期开发记录

- Bridge 会在心跳超时后释放挂起请求，避免失联页面永久占用活动租约；`bridge_select_client` 新增受限的 `force` 恢复选项，用于从已确认卡死的活动页面切换到新的就绪页面。
- `component_select` 支持直接传入 LCSC C 编号，并明确区分未关联 EasyEDA 器件库的商品与普通搜索未命中。

- 新增受确认保护的 `schematic_pages_manage`，支持创建、复制、重命名和完整验证后的页面重排；有意不提供页面删除。
- 新增受限的官方制造导出，包括飞针测试和自动布线/布局 JSON 文件。
- 新增只读的 `simulation_model` 搜索，可选 Ngspice/SimulIDE 过滤。
- 新增 `schematic_document_action`，支持受限的原理图坐标/区域检查、选择、图元查询、导航、保存和导入。
- 运行时支持时，在 `eda_context` 中加入客户端版本、模式、编辑器版本和编译日期。
- 扩展 `pcb_document_action`，支持受限的图元 ID/类型/BBox 查询、鼠标位置和明确选择控制。
- 新增 `pcb_layer_query`、`pcb_realtime_drc`、精确的 `component_select.properties` 搜索及外部布线/布局导入。
- 新增 `manufacture_templates_query` 和 `manufacture_export.template`，用于选择官方 BOM 模板。
- 新增官方器件、符号和封装搜索能力 `library_search`。
- 扩展 PCB 约束架构，支持规则配置和结构化布线规则数据。
- 新增受控的 PCB 文档保存及外部布线/布局导入。
- PCB 网络查询新增 `all`、`names` 和精确 `getNet` 模式，可选精确网络分析。
- `manufacture_export` 新增原理图 BOM 装配变体选择。
- 新增只读 `pcb_drc_check` MCP 工具，提供严格检查和结构化违规结果。
- 新增 `pcb_net_query` 工具定义并同步路由。
- 由于固定版本客户端未公开 PCB 自动布线方法，公共工具列表暂不包含自动布线控制；仍支持外部布线文件。
- 通过 `library_search` 暴露官方 LCSC C 编号映射；固定版本客户端未公开 `lib_SimulationModel`，因此暂缓仿真模型搜索。
- 扩展 `pcb_document_action`，支持受限图元/选择检查、坐标转换和画布导航。
- 为器件、符号和封装库资源新增精确 UUID 获取及受限 JSON 导出预览。
- 在架构校验阶段拒绝混合选择器、非精确 PCB 分析、不支持的图元过滤器和缺失的焊盘对组名称。

## 2.2.0 - 2026-08-23

- 新增原理图 DRC、PCB 约束、工程信息、网表比较和制造导出工具。

## 2.1.5 - 2026-08-23

- 不可取消的 EDA 修改操作超时后继续隔离 Bridge 客户端，避免后续任务与未完成的 API 调用重叠。
- 保留现有的 `bridge_select_client.force` 恢复路径，用于确认已失效的活动客户端。
- 本版本不改变 EDA 客户端的器件创建实现；只安全报告超时并防止队列损坏。

## 2.1.4 - 2026-08-17

- 将校验后的 `api_invoke` 和 `eda_context` 超时值传递给 Bridge 请求。
- 收到 Bridge 的任务开始确认后才启动执行超时，并完整转发主/次 Server 的超时值。
- 增加超时参数传递的回归测试。

## 2.1.3 - 2026-08-17

- 发布面向普通用户的最小 npm 安装包，并提供 `jlceda-mcp` 命令。
- 增加社区仓库、问题反馈、Apache-2.0 许可证和安全联系方式。
- 文档改为社区版原生 MCP 架构，移除过时的上游仓库和本地路径。
- 包含原生交互放置编排、工具路由同步检查、多客户端和 Bridge Token 保护。
