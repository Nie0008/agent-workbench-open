# Agent Workbench

macOS 上的本地多 Agent 桌面工作台，用于项目背景交接、任务派发、授权处理、进度查看和结果回收。当前版本 0.3.1，支持 Claude Code、Grok Build、DSH 和 ZCode；Codex 可通过 MCP 向工作台派发任务。

任务按工作目录归属项目。模型目录记录模型 ID、凭据来源与可用执行器，任务绑定创建时选定的模型；来源或模型变化时要求重新绑定，不会静默切换。每条任务后续消息复用执行器原生会话。运行结果仍需结合实际产物和验证证据核对。

## 运行

需要 macOS、Node.js 22.16 或更新版本、Python 3，以及所需执行器的本机安装和凭据。项目不包含模型账号、API 密钥或执行器安装包。

```sh
npm ci
npm test
npm start
```

`npm run build` 只构建应用。`npm run package -- --stage-only` 在 `release/` 生成未签名的 macOS 候选包；不带 `--stage-only` 会替换 `~/Applications/Agent Workbench.app`，先退出正在运行的任务并备份本机数据。

DSH 和 ZCode 的 Python 启动器默认从 `PATH` 查找 `node`、`dsh`。桌面环境找不到时，可设置 `WORKBENCH_NODE_PATH`、`WORKBENCH_DSH_PATH`。ZCode 不在默认安装位置时，可设置 `WORKBENCH_ZCODE_CLI` 和 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`。

## 凭据与数据

在「模型配置」中选择本机 CC Switch 供应商或 Grok 本机配置，并添加可用模型。Workbench 的模型目录保存模型和凭据来源的引用，不保存 API 密钥；实际调用时从本机配置读取凭据。缺少对应执行器或凭据时，该执行器不可用。

任务、项目背景和会话状态存在本机。应用通过选定的远端模型供应商执行任务；启用「夜间经验整理」后，Workbench 会在本地时间 03:00 或下次运行时，把启用后新增的成功任务要求与 Agent 结果发给配置好的智谱 `glm-5.3-flash`，生成待人工核对的项目经验草稿。首次启用不会补传更早的任务。该功能只读取 Workbench 自己记录的任务，不扫描其他客户端的独立会话。

仓库只应包含源码、测试和构建脚本。`.gitignore` 排除了依赖、打包产物、本机数据库、会话状态、凭据文件及内部验证报告。公开前仍应检查待提交文件。

## 运行边界

工作台默认在任务连续 15 分钟没有有效进展时停止任务；等待用户授权时暂停计时。收起窗口不会停止任务；退出应用会中断执行，重新打开后需要检查并继续。工作台不是独立后台守护服务，也不会在主控对话结束后主动唤醒 Codex。

自动测试使用模拟执行器和隔离数据，不会调用真实模型。通过测试只证明对应代码路径的行为，不代表本机所有客户端已连接、任务已完成或产物已验收。

## 许可

[MIT](LICENSE)。
