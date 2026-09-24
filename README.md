# JLCEDA MCP 社区版

当前发布版本：Bridge `2.3.2`，MCP Server `2.3.2`。本版本改进原理图当前页读取、器件放置、BOM 属性修改和连通性操作，并明确 PCB 导入与自动布局的提交状态。EDA 修改超时或连接失联后，Server 会保留诊断，按操作目标完成只读回读后才能恢复写入。

多页面连接时，首个页面未就绪会自动改选已就绪页面；显式选择或正在执行任务时不会自动切换。当前页写入使用执行时的实际图页身份进行恢复核对，提交状态不明时本机也立即阻止后续写入；跨图页的页面管理操作不能用当前图页回读解除隔离。完整安全恢复要求 Bridge 和 Server 均升级到 2.3.2。调用 `eda.pcb_PrimitiveComponent.getAll` 时可指定 `includeCompletePositions:true` 额外获取不截断的 `componentPositions`，通用 `result` 保持原有字段。

## 功能与工具

- `bridge_clients` 和 `bridge_select_client` 用于在已连接的 EDA 页面客户端之间切换 MCP 路由；它们不会切换同一个 EDA 进程中的可见标签页。如需在进程内切换标签页，请通过 `api_invoke` 调用 `eda.dmt_EditorControl.activateDocument(tabId)`。
- `bridge_recover_client`：不可取消 EDA 修改超时时，先从 `bridge_clients` 取得超时诊断的 `requestId`，再调用 `action=recover` 建立恢复会话。底层调用若持续挂起或 PCB 自动布局的提交状态未知，此后须重启原 EDA 宿主以终止旧调用；待新 Bridge 连接和全新 `clientId` 建立，按写入目标身份选择新客户端，再执行只读 `action=readback`。普通掉线重连保留旧 `clientId`，不能用于恢复回读。当前页绑定写入缺少执行时图页 UUID 时不能以旧心跳或手填 UUID 解除隔离；跨页器件删除需读回全工程 `schematic_review`。原理图当前页器件回读使用 `api_invoke` 调用 `getAllPrimitiveId` 或 `getAll`，传入 `args:[null,false]`；PCB 器件回读使用无参数的 `eda.pcb_PrimitiveComponent.getAll`。回读前始终阻止写操作，超时修改可能已经完成。
- `schematic_document_action`：检查原理图坐标、选中对象、区域图元、过滤器和鼠标位置；执行视图导航、图元选择、图元属性/BBox 读取、保存和变更导入。
- `schematic_layout_check`：基于结构化 EDA 几何估算原理图符号、引脚、属性文本、网络标签和导线重叠，报告密集区域与可选页面越界；`mode: "fix"` 仅在 `confirm: true` 时移动属性文本。
- `schematic_connectivity_action`：预览新导线与现有导线的接触、明确允许接触后创建导线，并创建或移动当前图页 NetPort；单条新导线最多传入 256 个坐标点。返回图元和网络回读状态。NetPort 适合同页连接与层次图端口，跨页连接应使用跨页连接标识。
- `schematic_pages_manage`：在 `confirm: true` 时创建、复制、重命名或完整重排原理图页面。重排必须提供每个当前页面 UUID，Bridge 会重新读取并验证结果；不提供删除功能。
- `pcb_drc_check`：读取 PCB 设计规则检查结果。
- `pcb_net_query`：按条件和数量限制查询当前 PCB 网络；精确网络图元过滤使用官方 `EPCB_PrimitiveType` 枚举。
- `schematic_drc_check`、`pcb_constraints_query`、`project_info` 和 `netlist_compare`：提供设计审查和工程身份信息；`project_info` 可选返回受限的 Board 和 Panel 清单。
- `eda_context`：在客户端支持时返回 JLCEDA/EasyEDA 版本、在线模式、编辑器版本、编译日期和当前画布数据单位。
- `eda_canvas_snapshot`：读取当前画布元数据，并可在明确请求时返回受限的只读 MCP 图像。
- `design_source_export`：读取当前文档或封装源文件的受限预览；完整源文本需要明确授权且受字节数限制。
- `design_archive_export`：读取原生当前工程/当前文档归档的元数据；只有明确请求时才返回受限的 Base64 数据，不写入文件。
- `library_preview` 和 `library_classification_query`：预览符号/封装资源并浏览受限的官方库分类树。
- `workspace_query`：查询当前工作区、团队、工程和文件夹，并发现可访问的资源。
- `design_compare`：调用官方原理图、PCB 和网表比较 API，并返回版本相关错误。
- `pcb_layer_query`：读取 PCB 层和铜层数量。
- `pcb_realtime_drc`：读取或明确启停 PCB 实时 DRC。
- `pcb_document_action`：读取 PCB 坐标、选中图元、区域图元、过滤器和画布状态；执行视图导航、保存、变更导入以及 Base64 自动布局/布线文件导入。
- `component_select`：支持精确器件属性查询，包括 LCSC `supplierId`。
- `library_sources`：列出系统、个人、工程和收藏库。
- `library_search`：搜索或读取 0.4.15 设备、符号、封装、3D 模型、可复用模块和 Panel 库资源，也支持仿真模型搜索；设备搜索支持精确属性和官方 LCSC C 编号映射。
- `pcb_constraints_query`：读取当前规则、规则配置、网络规则、区域规则和约束组。
- `manufacture_export`：生成受限的 BOM、Gerber、网表、贴片坐标等制造文件。
- `manufacture_templates_query`：列出 PCB BOM 模板或原理图装配变体；`manufacture_export` 可使用返回的装配变体。

`schematic_document_action` 与 `pcb_document_action` 的纯查询和画布导航可在写入隔离期间使用；改变选择状态、飞线计算、保存和导入仍按写操作隔离。

当前版本会拒绝空的自动布局/自动布线 UUID；EDA 修改超时后允许当前客户端执行只读查询，但读回结果在原调用仍挂起时只能视为暂时快照，写操作继续隔离。EDA 3.x 尚不支持普通网络标签的 `createNetLabel` API；电源/地标识仍可用。

PCB `import_changes` 返回 `pending_confirmation` 后，全局写入暂停，只读工具仍可用。从 `bridge_clients` 取得待确认 `requestId`；用户在 EDA 原生对话框点击“应用修改”或取消并确认对话框关闭后，调用 `bridge_recover_client`，传入 `action:"resolve_import"`、`confirm:true`、`requestId` 和 `resolution:"applied"` 或 `"cancelled"`。Server 会核对原 PCB 身份并完整读回器件和网络，Bridge 收到解除确认后才恢复写入。EDA API 无法报告对话框关闭，因此这一步依赖用户对原生操作的确认；若无法确认，应以 `action:"recover"` 建立会话，重启原 EDA 宿主，再用新 Bridge 客户端和 `hostRestartConfirmed:true` 执行完整 PCB 回读。EDA 3.2.181 的 BETA `pcb_Document.autoLayout` 可能超时后仍提交位置；Bridge 会标记结果未定，要求先读回全部器件坐标再重试。`pcb_Document.autoRouting` 若立即返回失败，需以导线、过孔和 DRC 读回判断实际结果，不能把 API 调用完成当作已布线。

交互放置等待用户退出当前放置模式，只把退出后仍存在的图元作为已放置结果；重复图元、连接失联或未知提交状态会停止后续放置。坐标放置发现已有器件或本批次已放置器件位号变化、或无法核对时会停止，并返回当前位号和已放置明细。`api_invoke` 的器件属性修改保留省略的 BOM 扩展属性，批量删除逐项执行并核对结果。

社区维护的嘉立创 EDA 专业版 MCP 集成基于 [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP) 改进。本项目不是嘉立创官方插件，也不代表上游维护者。

- 社区联系与安全报告：`hs150521@proton.me`
- 许可证：Apache-2.0
- Issue：<https://github.com/hs150521/JLCEDA-MCP-Community/issues>

## 架构

```text
Codex / Claude / Cursor / 其他 MCP 客户端
                  | STDIO MCP
                  v
       JLCEDA MCP Server 2.3.2
                  | 本机 WebSocket
                  v
       MCP Bridge 社区版 2.3.2
                  | JLCEDA 扩展 API
                  v
           嘉立创 EDA 专业版
```

市场中的 `.eext` 只包含 EDA Bridge；原生 MCP Server 需要从同一个 GitHub Release 另行安装。社区版不依赖旧版 VS Code/Cursor MCP Hub。

## 安装 2.3.2

需要 Node.js 20 或更高版本。

1. 从 [发布页](https://github.com/hs150521/JLCEDA-MCP-Community/releases) 下载并在嘉立创 EDA 扩展管理器中安装 `mcp-bridge-community-2.3.2.eext`。
   安装后在“已安装”的扩展详情中确认已允许“外部交互”，否则 Bridge 无法连接本机 MCP Server。
2. 下载 MCP Server 包并安装：

   ```powershell
   npm install --global .\jlceda-mcp-server-2.3.2.tgz
   Get-Command jlceda-mcp
   ```

3. 将 `jlceda-mcp` 配置为 AI 客户端的本地 STDIO MCP Server。

Codex：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 -- jlceda-mcp
codex mcp list
```

通用 JSON 客户端：

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "jlceda-mcp",
      "env": { "JLCEDA_BRIDGE_PORT": "8765" }
    }
  }
}
```

4. 打开嘉立创 EDA 原理图或 PCB 页面，Bridge 默认连接 `ws://127.0.0.1:8765/bridge/ws`。

生产使用建议配置随机 `JLCEDA_BRIDGE_TOKEN`。详细步骤和多客户端说明见[原生 MCP 安装说明](docs/native-mcp-setup.md)。

## 主要工具

- 原理图语义读取与全工程审查
- 器件搜索、交互放置和坐标自动放置
- 电源/地网络标识及普通网络标签
- 原理图与 PCB 网络查询
- 多 EDA 页面枚举与明确选择
- 受明确确认保护的 PCB 网类、差分对、等长组与 Pad 对组约束管理
- 可选的官方 EDA API 搜索和透传调用

## 安全与已知限制

- Server 仅监听 `127.0.0.1`，Bridge Token 不得提交或公开。
- MCP 写工具可修改当前工程；执行前请保存并核对活动项目和页面。
- 不要让旧版 MCP Hub 与原生 Server 同时占用端口 8765。
- 已在嘉立创 EDA 专业版 3.2.181 上测试。
- 官方 `createNetLabel` 从 EDA v4 起提供。Bridge 在 3.x 上对普通网络标签直接返回 `EDA_VERSION_UNSUPPORTED`，不会启动可能挂起的 EDA 调用；电源和地网络标识仍可使用。

## 开发与发布

```powershell
cd mcp-server
npm ci
npm test

cd ..\mcp-bridge
npm ci
npm run build
```

- [贡献与维护政策](COMMUNITY.md)
- [安全政策](SECURITY.md)
- [隐私与本地数据流](PRIVACY.md)
- [发布检查表](docs/publishing.md)
- [嘉立创扩展广场发布要求](https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html)
- [OpenAI Codex MCP 配置](https://developers.openai.com/codex/mcp/)
