# Agent Workbench

macOS 上的本地多 Agent 桌面工作台，用于项目背景交接、任务派发、授权处理、进度查看和结果回收。当前版本 0.3.3，支持 Claude Code、Grok Build、DSH 和 ZCode；Codex 可通过 MCP 向工作台派发任务。

任务按工作目录归属项目。模型目录记录模型 ID、凭据来源与可用执行器，任务绑定创建时选定的模型；来源或模型变化时要求重新绑定，不会静默切换。每条任务后续消息复用执行器原生会话。运行结果仍需结合实际产物和验证证据核对。

## 安装与运行

需要 macOS、Node.js 22.16 或更新版本、Python 3，以及所需执行器的本机安装和凭据。项目不包含模型账号、API 密钥或执行器安装包。

```sh
npm ci
npm test
npm start
```

`npm run build` 只构建应用。`npm run package -- --stage-only` 在 `release/` 生成未签名的 macOS 候选包；不带 `--stage-only` 会替换 `~/Applications/Agent Workbench.app`，并在 `~/.local/bin` 未占用时安装 `agent-workbench` 命令。正式安装前先退出正在运行的任务并备份本机数据。命令需要 `~/.local/bin` 在 `PATH` 中。

## 用一条命令派发任务

首次使用先在应用的「模型配置」中添加凭据和模型。源码安装可运行 `npm link` 获得 `agent-workbench` 命令，也可以把以下命令中的 `agent-workbench` 换成 `npm run cli --`。命令在需要时启动桌面应用。

```sh
agent-workbench agents
agent-workbench run --project /absolute/project/path --prompt '分析这个项目并给出建议'
agent-workbench run --project /absolute/project/path --prompt-file /absolute/task.txt --write
agent-workbench result TASK_ID
```

`agents` 列出当前可用的 Agent／模型组合；`run` 默认使用工作台保存的组合，未保存时使用 Claude Code。默认只读，`--write` 才允许在项目内修改文件。可用 `--agent ID --provider ID --model ID` 指定组合，用 `--detach` 只返回任务 ID；创建时输出的 `requestId` 可配合 `--request-id` 安全重试。任务需要授权或遇到冲突时，请在桌面应用中处理。CLI 返回的 Agent 文本仍需核对实际文件和验收要求。

仓库还包含可选的 [派发 Skill](skills/agent-workbench-dispatch/SKILL.md)。MCP 客户端可把 `agent-workbench mcp` 注册为 stdio 服务；MCP 工具访问运行中的 Workbench，凭据仍通过桌面应用配置。

DSH 和 ZCode 的 Python 启动器默认从 `PATH` 查找 `node`、`dsh`。桌面环境找不到时，可设置 `WORKBENCH_NODE_PATH`、`WORKBENCH_DSH_PATH`。ZCode 不在默认安装位置时，可设置 `WORKBENCH_ZCODE_CLI` 和 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`。

## 凭据与数据

在「模型配置」中可直接填写自己的 HTTPS Anthropic Messages 兼容端点、模型 ID 和 API key。已经使用 CC Switch 的本机用户可点某个来源旁的「复制到 Workbench」：主进程只读该来源配置，将 key 加密写入 Workbench，并复制其模型配置；不需要手工复制 key。重复点击可更新本地副本的 key。若原来源是默认来源，新任务的默认来源会改为 Workbench 本地副本。已有任务仍绑定原来源，尤其是可恢复的原生会话不会被静默换源；停用 CC Switch 前需逐项处理这些任务。Grok 登录仍由 Grok 管理。

一般 API key 选择 `ANTHROPIC_API_KEY`；使用代理令牌的端点选择 `ANTHROPIC_AUTH_TOKEN`。Workbench 用 macOS 系统安全存储加密本地 key，数据库只保存密文，界面不回显；系统安全存储不可用时拒绝保存。模型目录只保存模型与来源引用。缺少对应执行器或凭据时，该执行器不可用。当前直接填写的端点限 Anthropic Messages 兼容接口；Grok 自定义模型仍限项目已支持的智谱适配路径。

任务、项目背景和会话状态存在本机。应用通过选定的远端模型供应商执行任务；启用「夜间经验整理」后，Workbench 会在本地时间 03:00 或下次运行时，把启用后新增的成功任务要求与 Agent 结果发给配置好的智谱 `glm-5.3-flash`，生成待人工核对的项目经验草稿。首次启用不会补传更早的任务。该功能只读取 Workbench 自己记录的任务，不扫描其他客户端的独立会话。

仓库只应包含源码、测试和构建脚本。`.gitignore` 排除了依赖、打包产物、本机数据库、会话状态、凭据文件及内部验证报告。公开前仍应检查待提交文件。

## 运行边界

工作台默认在任务连续 15 分钟没有有效进展时停止任务；等待用户授权时暂停计时。收起窗口不会停止任务；退出应用会中断执行，重新打开后需要检查并继续。工作台不是独立后台守护服务，也不会在主控对话结束后主动唤醒 Codex。

自动测试使用模拟执行器和隔离数据，不会调用真实模型。通过测试只证明对应代码路径的行为，不代表本机所有客户端已连接、任务已完成或产物已验收。

## 许可

[MIT](LICENSE)。
