# DSH 固定 GLM 会话入口

2026-09-23：取代旧 DSH headless 一次性入口。仍是 CLI 封装，尚未注册为 Workbench 桌面适配器，不会自动出现在任务看板。

## 使用

所有命令在本仓库执行，项目目录使用绝对路径。

```sh
python3 scripts/agent-glm.py dsh check --cwd /path/to/project
python3 scripts/agent-glm.py dsh run --cwd /path/to/project --prompt-file /path/to/task.txt --timeout 300
python3 scripts/agent-glm.py dsh list --cwd /path/to/project
python3 scripts/agent-glm.py dsh status --cwd /path/to/project
python3 scripts/agent-glm.py dsh run --cwd /path/to/project --prompt-file /path/to/followup.txt --resume SESSION_ID --timeout 300
```

SESSION_ID 取自结果 `session.sessionId`，不是 Workbench taskId。不自动选择“最近一个会话”，避免多任务续接错误。`check` 只检查配置；`list` 无模型推理，`status` 只读本地最近20个回执。

模型来自 CC Switch 中唯一匹配的智谱 GLM 5.3 Flash。多匹配时显式传 `--provider-id`。本机回环代理校验令牌和模型，真实密钥不注入 DSH；会话按真实项目路径隔离存于 `~/.local/share/agent-workbench/fixed-dsh/<hash>/dsh-home`。旧 Web/headless 会话不自动迁移。每轮先保存 sessionId 回执，再发提示；正常结束执行 session/close，再等待进程退出。

`eventFile` 为实时ACP事件JSONL（可读取工具状态、输出），`runReceipt` 为运行回执。超时或连接断开时先检查回执和事件，不能因为没收到最终结果就重发；没有端到端消息幂等保证。同项目运行互斥，防止两个进程抢同一会话。运行参数超时10–14400秒，超时终止本次进程组，持久历史保留但本轮是否完成必须核对。

ACP `session/request_permission` 默认取消，写入 permission_denied，最终 success=false。此独立脚本入口不提供交互授权面板，也不自动批准工具。需要处理任务授权时，使用 [Workbench 主控接入](CONTROLLERS.md)。执行工具自身原本不要求确认的操作仍按其权限策略执行。
