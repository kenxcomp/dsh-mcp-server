# 主模型规划、Flash 执行

## 准备任务

主 agent 先阅读目标工程约束、查看已有修改，再将工作分成有明确验收条件的小任务。不要把整体目标原样转发给 worker，让它自行推测架构、授权和范围。

在 Claude Desktop、Cursor、Codex 中选择主模型，例如 GPT-6 Astra。桥接器配置 `deepseek-v4-flash` 只决定 worker 的模型，不会切换主模型。通过 [portable skill](../skills/deepseek-delegate/SKILL.md) 可以复用以下流程；没有 skill 时也可以直接使用 MCP 工具。

## 一次完整调用

假设 `/absolute/path/to/project` 已被 `DSH_MCP_WORKSPACE_ROOTS` 允许。

调用 `dsh_submit_task`：

```json
{
  "workspace": "/absolute/path/to/project",
  "objective": "修复 parseDate 对无效日期的异常，并补充对应测试。返回改动说明、验证命令及结果、未解决问题。",
  "allowed_paths": ["src/date.ts", "test/date.test.ts"],
  "constraints": [
    "遵循项目 AGENTS.md",
    "保留用户现有修改",
    "不得修改其他文件、新增依赖、提交或推送"
  ],
  "acceptance_checks": ["npm test -- test/date.test.ts"],
  "timeout_seconds": 600
}
```

从响应中取实际 `task_id`，再调用 `dsh_get_task`：

```json
{"task_id":"实际返回的任务 ID","wait_ms":10000}
```

如果仍在运行，继续最长 10 秒的等待；检查新输出再决定下一步，避免无等待紧密轮询。任务 deadline 独立于每次 MCP 调用的 timeout。

如果状态为 `awaiting_permission`，查看 `pending_permissions` 中的具体请求。上层 agent 需确认操作与用户任务、目标工作区和授权一致。已有授权充分时可继续；缺少必要授权时向用户说明具体请求。授权后的调用形状：

```json
{
  "task_id": "实际返回的任务 ID",
  "permission_id": "pending_permissions 中实际返回的权限 ID",
  "decision": "allow_once"
}
```

不应执行的请求使用 `"decision":"reject_once"`。不要从示例编造权限 ID，不要给所有请求自动批准，也不要把 `allowed_paths` 当成任意 shell 命令已经安全的证明。

需要终止时调用：

```json
{"task_id":"实际返回的任务 ID"}
```

将其交给 `dsh_cancel_task`。用 `dsh_get_task` 查看最终状态；取消不能撤销已经发生的修改。

`dsh_list_tasks({})` 可检查当前 server 进程内的任务，不会列出其他客户端实例或上次重启前的任务。

## 验收和后续任务

`completed` 仅表示 harness 已完成这一轮运行，不证明所有产品验收条件均满足。主 agent 应检查返回的 `result`、`tool_calls`、`error` 和 `output_truncated`，并检查真实工作区 diff、文件范围和必要的测试结果。

发生 `failed`、`cancelled` 或 `timed_out` 时，先检查部分改动，再决定重试、收缩任务或自行修复。不要重复提交可能已产生外部副作用的任务。

同一 checkout 的写任务串行执行。任务 B 依赖任务 A 时，先验收 A，再把必要上下文交给 B；不要假定独立临时 home 会共享前一个会话的记忆。不同客户端 server 实例之间没有统一锁，不能依赖本项目防止跨应用同时改同一项目。

## 安装技能

将整个 `skills/deepseek-delegate` 目录复制到目标项目：

```bash
mkdir -p /absolute/path/to/project/.agents/skills
cp -R /absolute/path/to/dsh-mcp-server/skills/deepseek-delegate \
  /absolute/path/to/project/.agents/skills/
```

Codex 和 Cursor 当前支持 `.agents/skills/<name>/SKILL.md`，可分别通过 `$deepseek-delegate` 或客户端技能选择器调用。已有同名 skill 时先比较内容再合并，不要直接覆盖用户版本。

Claude Desktop 的本地 MCP 接入不依赖此目录；可以在对话或项目指令中引用本流程。不要把 Claude Code 的 `.mcp.json` 或 skill 目录约定当成 Claude Desktop 的安装接口。
