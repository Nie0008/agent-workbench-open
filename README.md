# Agent Workbench

Agent Workbench 是本机多 Agent 工作台：用桌面界面、命令或标准 MCP 派发任务，管理 Claude Code、Grok、DSH、ZCode 执行器，并保存任务历史与项目背景。主控可以是 Codex、Claude Code CLI、DSH 或其他支持 MCP／命令执行的客户端；主控和任务执行器分别选择。

当前维护的公开仓库是 [Nie0008/agent-workbench-open](https://github.com/Nie0008/agent-workbench-open)，使用 [MIT 许可证](LICENSE)。原 `agent-workbench` 仓库已停止作为发布目标。

## 安装与初始化

当前源码版本为 **0.4.0 候选版**。支持 macOS Apple Silicon、macOS Intel 和 Windows x64 的便携打包；安装包未签名、未公证。当前尚未发布 GitHub Release，以下在线安装命令在对应 Release 发布后才可使用。Linux 和 Windows ARM64 暂未提供安装包。

macOS：

```sh
curl -fsSL https://github.com/Nie0008/agent-workbench-open/releases/download/v0.4.0/install.sh -o /tmp/workbench-install.sh && sh /tmp/workbench-install.sh --version 0.4.0
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://github.com/Nie0008/agent-workbench-open/releases/download/v0.4.0/install.ps1 -OutFile "$env:TEMP\workbench-install.ps1"; & "$env:TEMP\workbench-install.ps1" -Version 0.4.0
```

现在可从源码构建候选包，或使用自行核验的候选 ZIP 离线安装；ZIP 和同名 `.sha256` 文件须放在一起：

```sh
sh install.sh --archive /absolute/path/agent-workbench-0.4.0-darwin-arm64.zip
```

```powershell
.\install.ps1 -Archive C:\Downloads\agent-workbench-0.4.0-win32-x64.zip
```

安装器先校验 SHA-256，保留已有应用和命令的备份；目标应用正在运行时拒绝替换。它不安装 DSH 或其他 Agent。安装后扫描本机 Agent 和模型配置，询问是否导入；非交互安装仅显示发现项，不导入。macOS 首次打开未签名应用时，可按系统提示右键「打开」。

```sh
workbench scan --json
workbench setup
workbench connect dsh
workbench connect claude-code
workbench connect codex
workbench status
```

`setup` 仅导入用户确认的模型元数据与来源引用，不改变现有默认项。`connect` 只为指定主控登记 MCP，并保留原配置备份。macOS 的命令位于 `~/.local/bin`，终端未找到时运行 `export PATH="$HOME/.local/bin:$PATH"`；Windows 安装器添加当前用户 PATH，重新打开终端后生效。

## 用命令派发任务

首次使用先在应用的「模型配置」中配置可用模型与凭据。原有 `agent-workbench` 命令继续保留，安装包自带两种命令入口和运行时：

```sh
agent-workbench agents
agent-workbench run --project /absolute/project/path --prompt '分析这个项目并给出建议'
agent-workbench run --project /absolute/project/path --prompt-file /absolute/task.txt --write
agent-workbench result TASK_ID
```

`agents` 列出真正可用的 Agent／模型组合；`run` 使用已保存的默认组合，未保存时选择 Claude Code。默认只读，`--write` 才允许在项目内修改文件。可用 `--agent ID --provider ID --model ID` 指定组合，用 `--detach` 返回任务 ID；结果不明的重试保留并复用打印的 `requestId`。任务需要授权或遇到冲突时，在工作台中处理，再用 `result` 读取结果。

支持 MCP 的主控注册 `workbench mcp`；有命令执行能力的主控也可调用 `workbench call TOOL --args-file 参数.json`，参数与 MCP 工具一致。工具按需启动后台，窗口关闭时任务服务仍可工作。通用 [主控 Skill](skills/agent-workbench/SKILL.md) 和兼容 [派发 Skill](skills/agent-workbench-dispatch/SKILL.md) 随包提供。

## 模型与凭据

有两种配置方式：

- 在「模型配置」填写 HTTPS Anthropic Messages 兼容端点、模型 ID 和 API key。Workbench 使用系统安全存储加密凭据，数据库仅保存密文，界面不回显；安全存储不可用时拒绝保存。一般 API key 使用 `ANTHROPIC_API_KEY`，代理令牌使用 `ANTHROPIC_AUTH_TOKEN`。
- 使用本机已配置的 CC Switch、Claude Code 或 Grok 来源。扫描和 `setup` 只导入模型及来源引用，密钥留在原配置中，实际调用时读取。CC Switch 来源还可通过「复制到 Workbench」转为加密的本机副本，之后独立使用。

显式复制来源时保留原功能：复制其模型与 key；原来源若是默认来源，新任务默认组合改用 Workbench 本地副本。已有任务仍绑定原来源，可恢复的原生会话不会静默换源。停用外部来源前，应检查相关旧任务。Grok 登录仍由 Grok 管理；直接填写的自定义端点限 Anthropic Messages 兼容接口，Grok 自定义模型仍需项目支持的智谱适配路径。

新建任务时可保存每个 Agent 的默认模型。单次选择不改变默认；导入新来源也不覆盖已保存的默认配置。任务绑定创建时的模型与端点，配置改变后需明确重新绑定，已有原生会话切换模型应新建任务。凭据、本机数据库与客户端配置不随仓库或安装包分发。

## 授权与后台运行

创建任务时设置项目写入、额外只读目录、Bash 与网络权限。超出已授范围的请求进入待授权，旧任务不会因版本升级扩大权限。主控用 `workbench_wait_task_events` 等待结果或授权事件，读取完整请求后按用户已有授权响应；没有覆盖的操作由用户决定。

Claude Code 可通过 `isolatedChecks` 运行已明确授权的检查：指定本机 Docker 镜像完整 `sha256:` ID 和精确命令，工作台复制项目普通文件到临时目录，容器只读挂载该副本、使用有容量上限的临时内存盘、不联网、不传宿主环境变量。凭据名文件、隐藏文件、符号链接、`.git`、`node_modules` 和 `dist` 不进入副本；工具不拉取镜像。其他 Agent 的构建／测试 Bash 仍逐条请求确认。详见 [MCP 工具说明](docs/MCP接入说明.md)。

点击「收起到菜单栏」、关闭或最小化窗口，会先保存未发送内容与查看位置，再关闭窗口并释放界面进程；请求进行中等待其完成，保存失败则保留窗口。后台任务、MCP、托盘及授权通知继续运行；重新打开后恢复输入并读取历史。后台与执行器仍占用内存。

菜单栏／托盘「退出 Agent Workbench」或系统退出快捷键才结束服务，应用最多等待 8 秒释放执行器子进程。应用退出会中断执行，重新打开后应检查任务再继续。它不是独立后台守护服务，也不能在主控会话结束后主动唤醒主控。

工作台默认连续 15 分钟没有输出或工具进展时停止任务；有效进展重置计时，等待用户授权时暂停。Grok 推理进度只用于更新计时，不保存推理正文。任务结束后仍需核对实际产物、文件差异与验收条件，Agent 报告不等于验收通过。

## 项目背景与经验

项目背景与采用后的经验可提供给后续任务；草稿须核对后采用。启用夜间经验整理后，工作台在本地时间 03:00 处理启用后新增的主任务成功结果，错过时间则在下次唤醒或启动时补做。它只读取工作台自己记录的任务，不扫描其他客户端会话。

自动整理使用唯一可用的 CC Switch 智谱 `glm-5.3-flash` 配置；来源缺失、重复或失败时显示状态，不切换其他模型。生成内容是带任务引用的草稿，不自动成为已确认事实。

## 开发与打包

源码构建使用 Node.js 24。安装包自带 Electron／Node 运行时；DSH、Grok、ZCode 执行器使用本机已安装 CLI，DSH／Grok 还需要 Python 3。

```sh
npm ci
npm test
npm start
npm run build
npm run package:portable
```

`npm run package` 兼容原打包入口，但现在只生成候选文件，不替换正式应用。每个平台必须在对应的原生环境打包；CI 提供三平台构建和包运行检查，发布须使用与版本一致、已进入主线的标签。源码安装可用 `npm link` 获得 `agent-workbench`，或使用 `npm run cli -- agents`；新命令可用 `npm run workbench -- --help`。

## 文档与仓库范围

- [主控客户端接入](docs/CONTROLLERS.md)
- [外部 MCP 工具说明](docs/MCP接入说明.md)
- [任务调度与后台运行](docs/SCHEDULER-V1.md)
- [DSH 执行器接入](docs/DSH-ACP.md)

仓库保存源码、测试、构建脚本、许可证和产品使用文档。实施计划、内部设计草稿、详细验证记录及审计报告留在本机；依赖、安装包、本机数据库、会话与凭据不加入 Git。项目业务资料留在各自项目中。
