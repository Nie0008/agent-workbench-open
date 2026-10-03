# 任务调度与后台运行

Workbench 管理 Claude Code、Grok、DSH 和 ZCode 任务。主控可通过 MCP 或本地命令派发，具体接入方式见 [通用主控接入](CONTROLLERS.md)。可用执行器、模型和凭据来源以 `workbench_list_agent_options` 的返回为准。

## 派发与查看

保持 Workbench 后台运行。先读取项目与可用 Agent 组合，再创建任务并交接目标、材料、已授权的操作和验收条件。本次指定模型时显式选择可用组合；未指定时使用该 Agent 保存的默认组合。

创建时固定 `clientRequestId`。结果不明时，用同一标识和相同参数重试，返回原任务；不同参数会报错。继续原任务使用 `workbench_send_message` 和原 `taskId`，发送重试复用 `clientMsgId`，不通过新建任务掩盖恢复失败。

「任务看板」按项目文件夹展示最近 200 个已登记任务。项目行可排序、调整高度、展开或折叠；任务卡片可打开对话、查看授权与背景快照，或停止任务。已登记子任务显示在父任务下，外部独立启动的 Agent 不会自动导入。

窗口打开时，看板定时刷新，并在关键事件发生后更新。没有新输出只表示需要检查，不能据此判断进程已经退出。执行结束也不等于任务已经验收通过。

## 等待事件与授权

用 `workbench_wait_task_events` 等待 1–8 个任务：

```json
{"targets":[{"taskId":"TASK_ID","sinceSeq":0}],"timeoutMs":20000}
```

接口返回 `reason`、`events`、`cursors` 和 `serverTime`。下一次将 `cursors` 原样作为 `targets`；原因包括 `events`、`timeout`、`aborted` 和 `shutdown`。等待超时后可以继续等待；取消等待不会取消执行任务。

授权事件只是通知摘要。先用 `workbench_list_permissions` 核对完整操作，再根据已有用户授权调用 `workbench_respond_permission`。等待授权时暂停无进展超时计时，不能通过扩大权限跳过待处理的操作。

## 项目背景与经验

- `workbench_get_project_memory` 读取已确认背景；`workbench_update_project_memory` 用 `expectedVersion`、`facts` 和 `source` 更新，版本冲突时拒绝覆盖。
- `workbench_get_task_background` 返回任务创建时的背景快照。更新项目背景不会静默修改已创建任务。
- 项目经验先生成草稿，核对后明确采用。草稿、停用、被替代或过期条目不自动注入新任务。
- `workbench_get_task_memory_used` 可以查看任务首次输入实际使用的经验条目和版本快照。续接只追加消息，不重复注入同一背景。

更多经验与交接工具见 [MCP 工具说明](MCP接入说明.md)。

## 后台运行与限制

关闭、最小化或收起窗口时，Workbench 保存输入内容并释放界面进程，后台任务、MCP 和授权通知继续运行。保存失败时保留窗口与内容。重新打开后恢复输入并读取任务历史。

从菜单栏或系统托盘退出应用才会停止任务服务。退出可能中断执行，重新打开后需检查原任务并继续。Workbench 服务仍随应用运行，不是独立系统守护服务，也不能主动唤醒已结束的主控对话。

任务持续 15 分钟没有输出或工具进展时会停止；有效进展重新计时，等待用户授权时暂停。执行器报告的用量和费用可能不完整，未知费用不会估造。

任务报告及文件变更列表需要结合真实文件差异和验收条件核对；列表可能包含项目原有的未跟踪文件。
