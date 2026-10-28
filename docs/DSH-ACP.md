# DSH 执行器与独立 ACP 入口

日常派发使用 Workbench 的 DSH 适配器。主控先读取可用组合，再创建任务；任务看板、授权处理及续接方式见 [主控客户端接入](CONTROLLERS.md)。适配器使用绑定的供应商、模型和思考级别，不替用户选择固定模型。

## 独立脚本

以下命令在仓库目录运行。先安装 DSH 和 Python 3，并在 CC Switch 中配置所需的 Anthropic Messages 兼容来源。将示例中的 `PROVIDER_ID` 和 `MODEL_ID` 替换为自己的实际配置；项目目录和提示词文件使用绝对路径。

```sh
python3 scripts/agent-glm.py dsh check --cwd /path/to/project --provider-id PROVIDER_ID --model MODEL_ID
python3 scripts/agent-glm.py dsh run --cwd /path/to/project --provider-id PROVIDER_ID --model MODEL_ID --prompt-file /path/to/task.txt --timeout 300
python3 scripts/agent-glm.py dsh list --cwd /path/to/project --provider-id PROVIDER_ID --model MODEL_ID
python3 scripts/agent-glm.py dsh status --cwd /path/to/project --provider-id PROVIDER_ID --model MODEL_ID
python3 scripts/agent-glm.py dsh run --cwd /path/to/project --provider-id PROVIDER_ID --model MODEL_ID --prompt-file /path/to/followup.txt --resume SESSION_ID --timeout 300
```

`--model` 必填。可用 `--reasoning-effort` 指定 DSH 实际支持的思考级别；未指定时保留工具默认值，设置失败不会继续发送提示词。`SESSION_ID` 来自结果中的 `session.sessionId`，不是 Workbench 任务 ID；脚本不会自动选择最近会话。`check` 仅检查配置，`list` 不进行模型推理，`status` 只读取最近 20 个本地回执。

脚本使用带令牌和模型校验的回环代理，真实供应商密钥不注入 DSH。会话按项目路径隔离保存在 `~/.local/share/agent-workbench/fixed-dsh/<hash>/dsh-home`，不自动迁移旧会话，也不静默更换已绑定的供应商或模型。

结果中的 `eventFile` 是 ACP 事件文件，`runReceipt` 是运行回执。每轮先保存会话回执再发提示词；超时或连接断开后，先检查回执、事件和实际产物，再决定如何继续。该独立入口没有端到端消息幂等保证，不能因未收到最终结果就重复发送。同项目运行互斥；超时终止本次进程组，持久历史保留，但本轮是否完成仍须核对。

独立脚本默认取消 ACP 授权请求并报告失败，不提供交互授权面板。需要统一任务授权时，使用 Workbench 适配器。执行工具原本不要求确认的操作仍按其自身策略执行。
