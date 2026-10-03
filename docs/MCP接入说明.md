# 外部 MCP 接入说明（stdio）

Agent Workbench 提供一个 **stdio MCP 服务器入口**，外部客户端（如 Codex CLI、其他支持 MCP 的 Agent）可以调用与工作台界面**完全相同**的任务服务（同一 SQLite、同一会话、同一子任务调度）。MCP 创建/修改的任务会实时出现在工作台界面上。

安装包用户优先按 [通用主控接入](CONTROLLERS.md) 使用 `workbench connect` 和 `workbench mcp`，入口会按需启动后台服务。下文的原始入口配置适用于自行配置的客户端，需要先运行 Workbench。

## 架构

```
外部客户端 (Codex 等)
   │  stdin/stdout（MCP JSON-RPC 2.0）
   ▼
已安装应用的 dist/main/mcp/entry.js  ← 无状态转发
   │  HTTP POST 127.0.0.1:<port>（Bearer 随机令牌，令牌文件 0600）
   ▼
Agent Workbench 应用（回环控制服务 → TaskService → SQLite / Agent 子进程）
```

- 入口进程不直接访问数据库与凭据；所有操作都经运行中的工作台执行。
- 若工作台未运行，工具调用会返回明确错误（不会假装成功）。

## 启动

1. 启动 `/absolute/path/to/Agent Workbench.app`（应用会在数据目录写入 `control.json`，含回环端口与令牌，权限 0600）。
   - 数据目录：`~/Library/Application Support/Agent Workbench/`
2. 在 MCP 客户端配置中登记本入口。

### Codex 桌面客户端接入（config.toml）

编辑 `~/.codex/config.toml`（手动添加以下片段）：

```toml
[mcp_servers.agent-workbench]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/Agent Workbench.app/Contents/Resources/app/dist/main/mcp/entry.js"]
```

- `command` 用 node 绝对路径（版本 ≥22.16）。
- 入口文件随已安装应用提供；升级应用后，MCP 入口与运行中的后端保持同版。本机 `$agent` Skill 的 `call.py` 也使用该入口。
- 运行前提：**Agent Workbench 应用处于运行状态**（入口经数据目录 `control.json` 连接运行中的工作台）。
- control.json 缺失/失效：重启工作台即可重新生成；入口无需任何配置变更。
- 也可显式指定 control 文件：`args` 末尾追加 `"--control", "/path/to/control.json"`。

### 错误处理

| 报错 | 原因与处理 |
| --- | --- |
| 工具返回 `工作台应用未运行（未找到 control.json）` | 启动工作台后重试 |
| `控制通道连接失败` | 工作台已退出但 control.json 残留：重启工作台刷新 |
| `控制通道超时` | 工作台主线程繁忙（如模型回合执行中），稍后重试 |
| 建任务后无事件 | 确认 projectId 正确（先 `workbench_list_projects`） |


## 工具列表

| 工具 | 说明 |
| --- | --- |
| `workbench_list_agent_options` | 列出真正接入的 Agent 与可用的 `agentId`/`providerId`/`model` 组合；仅返回元数据，不返回凭据。先查此项再派发。 |
| `workbench_list_projects` | 列出项目 |
| `workbench_list_tasks` | 列出任务（可按项目过滤） |
| `workbench_create_task` | 新建主任务并发送首条提示词；`fileWrite` 默认 `false`，`clientRequestId` 用于建任务幂等。`readRoots` 可指定已获授权的项目外只读目录。可传 `isolatedChecks: {image,commands}` 授权 Claude Code 用本地 Docker 镜像 ID 执行精确构建/测试命令。 |
| `workbench_send_message` | 用原 `taskId` 继续对话；结果不明的重试复用 `clientMsgId`。 |
| `workbench_get_task` | 查询任务详情（状态/模型/摘要） |
| `workbench_get_task_events` | 读取事件流（文本增量、工具调用、文件变更、授权请求等） |
| `workbench_read_task_result` | 读取结果（状态/摘要/变更文件/用量） |
| `workbench_cancel_task` | 取消任务（父任务会级联停止运行中的子任务） |
| `workbench_merge_task` | 将子任务 worktree 改动合并回主树（先查冲突，不覆盖未提交改动） |
| `workbench_list_project_memories` | 列出指定项目的经验条目，可按状态和类型筛选。 |
| `workbench_search_project_memories` | 在指定项目内搜索中英文关键词，返回命中词和词法分数；不是语义正确率。 |
| `workbench_get_project_memory_entry` / `workbench_get_project_memory_history` | 读取本项目条目或其历史版本；跨项目 ID 会拒绝。 |
| `workbench_create_project_memory_draft` | 创建草稿；关联来源、任务、证据和有效期，可传 `requestId` 防重复。新条目默认草稿。 |
| `workbench_update_project_memory_entry` | 按 `expectedVersion` 修改条目，版本冲突时拒绝覆盖。 |
| `workbench_set_project_memory_status` | 按版本采用或停用；只有已采用且未过期条目会自动检索注入。 |
| `workbench_replace_project_memory_entry` | 原子创建已采用的新条目并替代旧条目，保留版本及替代链接。 |
| `workbench_create_task_handoff_draft` | 从任务最后一条成功结果事件生成“Agent 报告，待核对”草稿；失败/取消结果不生成。 |
| `workbench_get_task_memory_used` | 查看任务首次输入实际使用的条目 ID、版本、来源及正文快照。 |

桌面端可从顶部「项目背景」管理已确认背景和项目经验。已确认背景继续优先；经验只作为显式参考，不覆盖本次要求或权限。交接结果始终是待核对草稿，不会自动采用。只有明确采用且未过期的经验会用于后续新任务；已经开始的任务保留当时的背景快照，续接不会重复注入。

`isolatedChecks.image` 必须是 `docker image inspect --format '{{.Id}}' <镜像>` 返回的完整本地 `sha256:` ID；`commands` 是 1–10 条单行精确命令。它们作为任务授权快照和幂等指纹保存。Claude Code 任务使用内置 `mcp__workbench__run_isolated_check` 执行；普通 Bash、ZCode 构建/测试和现有任务不会因此获得新权限。Windows 暂不支持隔离检查：新建任务传入此范围会被拒绝，已有任务调用该工具也会返回检查未运行的错误。范围外命令会产生待授权，用户可从桌面任务卡片或 `workbench_list_permissions`/`workbench_respond_permission` 处理。通知用户不等于自动唤醒已结束的 Codex 对话；跨 Agent 自动交接仍需外部编排。

`readRoots` 是创建任务时传入的最多 20 个具体、现存的绝对目录。只有用户已授权读取这些目录时才传入；工作台保存目录的真实路径，仅用于 `Read/Glob/Grep/LS` 的目标核验。目录内的链接不能把授权扩大到其他位置，批量读取中任何目标越界都会请求确认。它不允许项目外写入，也不授予自由形式 Bash 或关闭沙箱的权限。旧任务缺省为空，不因升级自动扩大权限；相同创建请求仍须复用原 `clientRequestId`。

派发方需要持续跟进时，可由已获委派授权的子代理使用 `workbench_wait_task_events` 接收关键事件；普通输出和 20 秒等待超时不代表失败。收到授权事件后，先用 `workbench_list_permissions` 核对完整操作，再按已有用户授权逐项响应，随后等待真实结果。跟进代理只处理交接的 taskId，结束时回报产物、错误及剩余待办。该方式依赖当前 Agent 会话继续运行，不能承诺跨会话常驻或唤醒已结束对话。

## 模型选择

Workbench 的「模型配置」集中保存模型 ID、凭据来源和可用 Agent。多个模型可引用同一 CC Switch 供应商；Grok Build 还可使用本机 Grok Super 登录或 Grok 配置。新建任务窗口可将组合保存为对应 Agent 的默认模型；此后仅传 `agentId` 即使用该默认。一次性指定 `providerId/model` 不改默认。同一任务续接使用原绑定；切换模型需新建任务。来源或端点不匹配时不会自动改派。实际可用组合以 `workbench_list_agent_options` 的当前返回为准。

## 安全说明

- 控制通道仅绑定 `127.0.0.1`，令牌随机生成，文件权限 0600。
- MCP 入口进程不接触任何凭据；凭据仍只由工作台主进程定向读取并注入 Agent 子进程环境。
