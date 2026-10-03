# 外部客户端主控接入

DSH、Claude Code CLI、Codex 都可以作为主控，通过同一套 Workbench 工具登记项目、派发任务、处理已有授权和回收结果。主控负责目标和验收；Workbench 管理执行器、任务历史与后台服务。主控的模型和任务执行器的模型分别选择，使用 DSH 主控并不要求任务也由 DSH 执行。

本文中的 `workbench` 是安装后可执行的命令。先运行 `workbench scan --json` 检查本机程序；`workbench setup` 扫描并按用户确认导入已有配置，不安装缺失的客户端。客户端需按各自官方方式安装。Workbench 接入配置不包含模型密钥；执行器使用本机已配置的凭据来源。

## 两种调用方式

支持 MCP 的客户端使用 stdio 入口：

```sh
workbench mcp
```

入口按需启动后台任务服务，标准输出只承载 MCP 协议。关闭 MCP 连接不等于退出任务服务。`workbench status` 查询当前服务，`workbench start` 可提前启动；任务服务状态和客户端发现工具成功是两个不同的检查。

有命令执行能力的主控也可以调用相同工具，无须修改客户端 MCP 配置：

```sh
workbench call workbench_list_agent_options < options.json
workbench call workbench_create_task --args-file create-task.json
```

`options.json` 内容为 `{}`。参数文件采用 JSON，工具名和字段与 MCP 相同。创建、发送、授权等操作仍由 Workbench 校验；命令入口不提供额外执行权限。

## 接入客户端

只在用户要求接入对应客户端时运行：

```sh
workbench connect codex
workbench connect claude-code
workbench connect dsh
```

每次只接入指定客户端，保留原配置并提供备份位置。运行 `scan`、普通工具查询和加载主控 Skill 不会代替用户执行 `connect`。客户端可能还要求信任项目或批准启用 MCP，按客户端显示的具体提示处理。

Windows 的 `workbench.cmd` 供命令行使用。`connect` 为 MCP 注册实际的打包 `electron.exe`、CLI 文件绝对路径和 `mcp` 参数，并设置 `ELECTRON_RUN_AS_NODE=1`，因此无需客户端直接启动 `.cmd`，也无需另装 Node。手动注册时采用相同的 stdio 配置：

```json
{
  "command": "C:\\Workbench\\app\\electron.exe",
  "args": ["C:\\Workbench\\app\\resources\\app\\dist\\main\\cli.js", "mcp"],
  "env": {"ELECTRON_RUN_AS_NODE": "1"}
}
```

路径换成实际安装位置；Claude Code 的 JSON 服务器配置另加 `"type": "stdio"`，DSH patch 的 `config` 另加 `"transport": "stdio"` 和 `serverName`。`connect` 负责生成对应格式。后台应用启动时会清除 Node 模式变量。

### Codex

原生 stdio 注册命令是：

```sh
codex mcp add agent-workbench -- /absolute/path/to/workbench mcp
codex mcp get agent-workbench --json
```

也可在已备份的 Codex 配置中添加等效内容：

```toml
[mcp_servers.agent-workbench]
command = "/absolute/path/to/workbench"
args = ["mcp"]
```

换成当前机器的可执行文件绝对路径。在新会话中确认 Workbench 工具可见，先调用 `workbench_list_projects`。添加配置或 `mcp get` 成功，只证明配置已登记。语法依据 [Codex MCP 文档](https://developers.openai.com/codex/mcp)及当前 CLI 的 `codex mcp add --help`。

### Claude Code CLI

用户级 stdio 注册命令是：

```sh
claude mcp add --transport stdio --scope user agent-workbench -- /absolute/path/to/workbench mcp
claude mcp get agent-workbench
```

`--transport`、`--scope` 等客户端选项放在服务器名之前，`--` 后是 Workbench 命令及参数。也可以选择客户端原生的项目或本地作用域；不要把 Claude Desktop 的配置文件当作 Claude Code CLI 配置。语法依据 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)及当前 CLI 帮助。

一次性隔离试用可以给 Claude CLI 的 `--mcp-config` 传入 JSON 文件，而不修改现有用户配置：

```json
{
  "mcpServers": {
    "agent-workbench": {
      "type": "stdio",
      "command": "/absolute/path/to/workbench",
      "args": ["mcp"]
    }
  }
}
```

### DSH

DSH 使用 profile patch；当前 CLI 没有 `dsh mcp add` 命令。`workbench connect dsh` 写入一个独立的 Workbench patch，并返回其位置和启动方式，不覆盖 DSH 原有模型、凭据或 profile。

对已具备模型配置的 profile，可以显式加载这个 JSON patch：

```json
[
  {
    "insert": [
      {
        "id": "mcp-workbench",
        "name": "@deepseek-ai/dsh-mcp-client",
        "config": {
          "serverName": "agent-workbench",
          "transport": "stdio",
          "command": "/absolute/path/to/workbench",
          "args": ["mcp"],
          "failOnStartupError": true
        }
      }
    ]
  }
]
```

```sh
dsh --profile headless --patch /absolute/path/to/workbench-mcp.json "列出 Workbench 项目，不创建或修改任务"
```

可换成自己已经配置的兼容 profile；只加载一次该 patch，避免重复插入同名插件。`--dump-config` 可在隔离配置目录中检查合成结果，但配置可能含有敏感值，不要把已有用户配置的完整输出贴到日志或聊天。

模型中的工具带 `mcp__agent-workbench__` 前缀，原始工具名仍是 `workbench_list_projects` 等。配置依据 [DSH MCP 客户端插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)。这条外部主控接入路径与 Workbench 内部 DSH 执行器分开；内部 ACP 执行器传入空 MCP 列表，不限制外部 DSH 客户端连接通用入口。

## 派发与跟进

将仓库的 `skills/agent-workbench/SKILL.md` 放入客户端支持的 Skill 目录，或让主控读取该文件。安装 Skill 与添加 MCP 配置是不同操作；Skill 不携带客户端认证配置。

先调用 `workbench_list_agent_options` 和 `workbench_list_projects`，使用返回的实际组合与项目 ID。未指定模型时使用对应执行器在工作台保存的默认组合；指定模型时须与当前可用组合匹配。把执行目标、所需材料、已授权的操作和验收条件一并交接。

创建工具的权限参数是顶层字段，示例：

```json
{
  "projectId": "PROJECT_ID",
  "title": "核对项目说明",
  "prompt": "读取项目 README，返回需要更正的事实和对应文件位置，不修改文件。",
  "agentId": "AGENT_ID_FROM_OPTIONS",
  "clientRequestId": "STABLE_REQUEST_ID",
  "fileWrite": false,
  "bash": "none",
  "network": false
}
```

结果不明时，用完全相同的参数和 `clientRequestId` 重试。继续原任务用 `workbench_send_message` 的 `taskId`、`message` 和稳定 `clientMsgId`，不重新创建任务来掩盖恢复失败。`readRoots` 只用于已获授权的额外具体只读目录；`bash=readonly` 不等于任意只读 Shell 命令免审批。详细范围见 [MCP 接入说明](MCP接入说明.md)。

以 `workbench_wait_task_events` 等待 1–8 个已派发任务：

```json
{"targets":[{"taskId":"TASK_ID","sinceSeq":0}],"timeoutMs":20000}
```

下一次直接使用返回的 `cursors` 作为 `targets`。超时继续等待，不能据此认定失败。授权事件是通知摘要；用 `workbench_list_permissions` 读取该任务完整操作，按已有用户授权逐项决定，再调用 `workbench_respond_permission`。不能因文件工具是 Read、命令被称作“只读”或 Agent 自述安全就放行；要核对真实目标、参数与影响。

读取结果后核验实际文件、差异或任务要求的其他证据。`idle` 表示本轮结束，不能替代验收。主控当前会话中的跟进或监督子代理在对应任务完成、失败或取消后结束；后台运行本身不保证唤醒已经结束的主控会话。

## 适用范围

当前已核对的真实主控调用范围为 macOS 上的 DSH、Claude Code CLI、Codex CLI、Grok CLI 和 ZCode app-server 派发 Claude Code 文本任务。其他平台、客户端版本、模型和复杂编排需要在对应环境核对。

接入后先确认工具可见，读取项目和可用 Agent 组合，再用明确授权的任务检查派发、授权处理与结果回收。客户端注册成功不代表任务已经执行成功；主控仍需核对实际产物。
