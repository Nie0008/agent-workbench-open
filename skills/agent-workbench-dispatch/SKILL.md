---
name: agent-workbench-dispatch
description: Use the installed Agent Workbench CLI to send a project task to a configured agent and read its result.
---

# Agent Workbench dispatch

Use this skill when the user asks to run a task through Agent Workbench. The desktop app must have a model and credential configured first.

1. Run `agent-workbench agents` to see real available combinations. If no command is installed, use `npm run cli -- agents` from the cloned repository.
2. Use `agent-workbench run --project /absolute/project/path --prompt-file /absolute/prompt.txt` for a task. Add `--agent ID --provider ID --model ID` only when selecting a specific available combination. Add `--write` only when the user authorized file changes. Without it the task is read only.
3. Keep the printed `requestId` and `taskId`. If a request is interrupted and needs a retry, pass the same `--request-id` with the same arguments to avoid creating a duplicate task.
4. The command prints the agent's result when the turn ends. A task needing permission or conflict handling exits with code 2; inspect it in the Workbench app, then use `agent-workbench result TASK_ID` to read its status. Verify changed files and acceptance criteria yourself.

Never put an API key in the prompt, command arguments, Skill file, or repository. Configure credentials in the Workbench model settings. MCP clients can also register `workbench mcp` (or the compatible `agent-workbench mcp`) as a stdio server; that exposes Workbench task tools, not credential management.
