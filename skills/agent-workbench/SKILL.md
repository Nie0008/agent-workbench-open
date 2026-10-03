---
name: agent-workbench
description: 通过本机 Agent Workbench 派发、继续和跟进外部执行器任务，核对授权并回收结果；适用于支持 MCP 或命令执行的 DSH、Claude Code、Codex 等主控客户端。
---

# Agent Workbench 主控

使用现有 MCP 工具；没有原生 MCP 入口时，调用 `workbench call TOOL_NAME --args-file 参数.json` 或从标准输入传入 JSON。主控客户端和任务执行器是独立选择，不固定某个客户端、模型或供应商。

`workbench mcp` 和 `call` 按需启动后台服务。先用 `workbench scan --json` 检查本机程序；需要导入已有配置或接入客户端时，按用户要求使用 `setup`、`connect <dsh|claude-code|codex>`。`setup` 不安装缺失客户端。普通派发不需要修改客户端配置。接入语法和验证层级见仓库或安装包的 `docs/CONTROLLERS.md`；本 Skill 单独安装时仍按下列步骤执行。

## 派发和恢复

- 用 `workbench_list_agent_options` 读取真正可用的 `agentId/providerId/model` 组合，用 `workbench_list_projects` 确认项目；仅在用户授权的新项目需要登记时调用 `workbench_create_project`，参数为 `rootPath` 和可选 `name`。
- `workbench_create_task` 必需字段是 `projectId/title/prompt`；`agentId/providerId/model/background/clientRequestId` 和授权参数都是顶层字段。交接目标、材料、已授权操作和验收条件，不能把已有主控对话当作执行器已收到的背景。
- 创建前生成稳定的 `clientRequestId`，保留实际参数与返回 `task.id`。结果不明的重试复用原 ID 和完全相同的参数，不盲目重复派发。
- 继续用原 `taskId` 调 `workbench_send_message`：`{taskId,message,clientMsgId}`。每条新消息生成一个稳定 `clientMsgId`，重试复用它。恢复失败先读任务及事件，不能以新任务冒充原任务续接。
- 按当前 `tools/list` schema 调用，不把创建字段包装成不存在的 `scope` 参数。多个普通创建任务不会自动形成父子关系；只有实际委派登记后才称为子任务。

## 授权范围

- `fileWrite` 默认 false；用户已授权项目内修改才传 true。
- `readRoots` 是最多 20 个已授权、现存的具体绝对目录，只扩大文件工具的读取范围，不扩大写入或 Bash。
- `bash` 为 `none` 或 `readonly`；后者只覆盖工作台实现的固定系统读取/指纹命令，任意 Shell、测试命令和关闭沙箱仍须核验。
- `network` 默认 false；明确授权网络工具时才传 true。
- `isolatedChecks` 只给支持它的执行器，包含已在本机的完整镜像 `sha256:` ID 与逐条明确授权的精确命令。它不授予宿主 Bash 权限。

收到授权事件，调用 `workbench_list_permissions` 的 `{taskId}` 读取完整输入和越界原因。对已覆盖的操作，逐项用 `workbench_respond_permission` 的 `{taskId,permissionId,decision:"allow"|"deny"}` 响应；无法可靠确认授权时把真实操作交给用户决定。仅处理本次交接的 taskId；不能依靠模型置信度、工具名、只读标签或全局自动批准代替授权核对。

## 跟进和验收

`workbench_wait_task_events` 参数为：

```json
{"targets":[{"taskId":"TASK_ID","sinceSeq":0}],"timeoutMs":20000}
```

一次等待 1–8 个任务，之后将返回的 `cursors` 原样作为下一次 `targets`。`reason=timeout` 是等待超时，继续等待；`shutdown/aborted` 要重新核对服务和任务，不能报告完成。普通流式输出不会每次唤醒等待。

在当前主控会话中持续跟进；有委派授权时可交给监督子代理，让它只处理指定 taskId、核对完整权限、返回需要用户决定的操作，并跟到结果或真实失败。完成、失败或取消后结束监督；不能承诺跨会话常驻或唤醒已结束客户端。

用 `workbench_get_task`、`workbench_get_task_events` 和 `workbench_read_task_result` 核对状态、实际执行器、模型、原生会话及结果。读取事件时按返回的最后一个 `seq` 续页，避免只看前 2000 条。`idle` 只表示该轮结束；工具回执、Agent 自述或摘要都不能代替文件、差异与要求的验证。

向用户报告实际产物、验证范围、剩余授权及失败条件；区分源码检查、协议调用、真实模型调用和业务验收。不要打印模型凭据或回环控制令牌。
