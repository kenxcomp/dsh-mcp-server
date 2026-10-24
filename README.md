# dsh-mcp-server

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 作为 MCP 工具接入 Claude Desktop、Cursor、Codex：主模型负责规划和验收，DeepSeek Flash 在指定本地工作区执行小任务。

```text
Claude Desktop / Cursor / Codex 中的主 agent（例如 GPT-6 Astra）
  → stdio MCP → dsh-mcp-server
  → ACP stdio → 官方 dsh --profile acp
  → DeepSeek Flash + Harness 的文件、终端等工具
```

这是一个独立 MCP server，调用官方 harness 的 ACP 入口。无需更换主客户端的模型；主模型仍由用户在客户端选择。本项目也不提供 OpenAI/Claude 模型路由或通用模型 API 代理。

## 快速开始

1. 安装 Node.js 24.9.0 或更新的兼容版本和官方 harness：

   ```bash
   npm install -g @deepseek-ai/dsh@0.2.1-rc.2
   command -v node
   command -v dsh
   ```

   本项目针对上述 harness 版本开发。官方仍快速迭代；升级后应重新验证 ACP 兼容性。

2. 在本仓库构建：

   ```bash
   npm install
   npm run build
   ```

3. 选择凭据来源：

   - **API key**：在仓库外准备仅当前用户可读的环境文件，例如 `/absolute/protected.env`，放入 `DEEPSEEK_API_KEY`；不要提交该文件，不要在聊天、日志或命令历史中粘贴真实密钥。
   - **已有 dsh 凭据**：配置 `DSH_MCP_CREDENTIALS_FILE`，显式引用已有的 `.dsh/.credentials.yaml`，详见下方[复用 dsh 凭据](#复用-dsh-凭据)。无需导出或复制其中的密钥、账号令牌。

   ```bash
   chmod 600 /absolute/protected.env
   ```

   API key 模式中，如果 MCP 进程已通过可信方式获得该环境变量，可省略下面的 `--env-file`。本项目为每个任务创建独立临时 `DSH_HOME`；只有显式指定凭据文件时才引用该存储，不自动复用用户 profile 或会话。

4. 用客户端配置启动；以下为 API key 模式的启动入口示意：

   ```bash
   DSH_MCP_WORKSPACE_ROOTS='["/absolute/path/to/project"]' \
   DSH_MCP_COMMAND=/absolute/path/to/dsh \
   node --env-file=/absolute/protected.env /absolute/path/to/dsh-mcp-server/dist/index.js
   ```

   这是 stdio 协议进程，启动后等待 MCP 输入。实际使用时由客户端管理它，不需要另开终端常驻。Node 和 dsh 的绝对路径取自第 1 步，工作区必须是已存在的真实目录。

## 复用 dsh 凭据

`DSH_MCP_CREDENTIALS_FILE` 接受现有凭据文件的绝对路径。桥接器只校验文件元数据：必须是已有常规文件，POSIX 上还需归当前用户所有且仅所有者有访问权限（通常为 `600`）。桥接器不读取、解析或复制令牌；它在每个临时 ACP profile 中配置官方 credentials provider，由 harness 直接使用该存储。

保存的 **API key** 与 **DeepSeek 账号登录** 是不同的认证方式，需选择相应路由：

| 凭据方式 | provider | Flash 模型配置示例 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` 环境变量，或显式引用的存储中已有 API key | `deepseek-official` | `deepseek-v4-flash` |
| 显式引用的存储中已有 DeepSeek 账号登录 | `deepseek-account` | `deepseek-flash` |

这些模型标识需与当前 harness 和账号实际提供的目录匹配。桥接器使用 ACP 广告的模型选项并确认选择，不会在目标模型不可用时静默切换到其他模型。

账号登录的 Codex 示例见 [codex-account.toml](examples/codex-account.toml)。该模式不需要 `--env-file`。凭据文件仍由官方 harness 管理，正常账号刷新可能更新原存储，按官方跨进程写锁协调；调用使用对应账号的额度和计费规则。独立临时 home 隔离会话与 profile，不隔离显式共享的凭据存储。

## 接入客户端

配置示例需要替换所有 `/absolute/...` 路径，再合并到已有配置，不要覆盖其他 server。GUI 客户端的 PATH 与终端可能不同，建议 Node 和 dsh 都用绝对路径。

| 客户端 | 配置位置 | 示例 |
| --- | --- | --- |
| Claude Desktop（macOS） | `~/Library/Application Support/Claude/claude_desktop_config.json`，或 Settings → Developer → Edit Config | [claude-desktop.json](examples/claude-desktop.json) |
| Cursor | 项目 `.cursor/mcp.json` 或用户 `~/.cursor/mcp.json` | [cursor.json](examples/cursor.json) |
| Codex | `~/.codex/config.toml`，或受信任项目 `.codex/config.toml` | [API key](examples/codex.toml) / [dsh 账号登录](examples/codex-account.toml) |

Claude Desktop 和 Cursor 使用 `mcpServers` JSON。Codex 使用 `[mcp_servers.deepseek-harness]` TOML；本机 CLI 也支持：

```bash
codex mcp add deepseek-harness -- /absolute/path/to/node \
  --env-file=/absolute/protected.env \
  /absolute/path/to/dsh-mcp-server/dist/index.js
```

此命令只注册启动命令；仍需按 [Codex 示例](examples/codex.toml) 配置工作区等环境变量。配置完成后按各客户端要求重新连接或重启，再检查是否出现 `dsh_submit_task` 等工具。Skill 的安装不能代替 MCP 配置。

## Astra 规划、Flash 执行

在客户端选择你希望负责规划的主模型，再请求：

> 先规划这个项目的改动，拆成可验收的小任务。通过 DeepSeek Harness MCP 把执行任务交给 Flash，保留当前工作区已有修改。每次明确允许修改的文件、约束和验收标准；收到结果后由你检查 diff 并运行必要验证。

主 agent 调用工具的真实参数形状：

```json
{
  "workspace": "/absolute/path/to/project",
  "objective": "修复日期格式化函数对无效日期的处理，并补充对应回归测试。",
  "allowed_paths": ["src/date.ts", "test/date.test.ts"],
  "constraints": ["保留已有用户修改", "不新增依赖，不提交，不推送"],
  "acceptance_checks": ["npm test -- test/date.test.ts"],
  "timeout_seconds": 600
}
```

将上述对象传给 `dsh_submit_task`，取得 `task_id` 后用 `dsh_get_task({"task_id":"返回的任务 ID","wait_ms":10000})` 等待。遇到 `awaiting_permission` 时先查看 `pending_permissions`，根据用户已有授权判断具体请求，再调用 `dsh_respond_permission` 一次性批准或拒绝；授权不足时先向用户说明具体操作。不要因使用 delegation skill 自动批准所有权限。

任务完成后主 agent 检查 `result`、`tool_calls`、`output_truncated` 和失败信息，并在实际工作区检查改动与验收结果。`acceptance_checks` 是给 worker 的指令，不是 server 自动执行的 shell 命令。

可将 [deepseek-delegate skill](skills/deepseek-delegate/SKILL.md) 复制到目标项目 `.agents/skills/deepseek-delegate/SKILL.md`，供支持此约定的 Codex、Cursor 等客户端发现。它也可以直接作为其他客户端的工作流提示；Claude Desktop 无须安装此 skill 才能调用 MCP 工具。

## 工具

| 工具 | 用途 |
| --- | --- |
| `dsh_submit_task` | 创建有时限的独立 harness 任务，立即返回 `task_id` |
| `dsh_get_task` | 读取状态、文本结果、工具活动和待处理权限；`wait_ms` 为 0–10000 |
| `dsh_list_tasks` | 列出本 server 进程的任务 |
| `dsh_cancel_task` | 取消指定任务并结束对应 harness 进程 |
| `dsh_respond_permission` | 针对一个待处理权限选择 `allow_once` 或 `reject_once` |

状态为 `starting`、`running`、`awaiting_permission`、`completed`、`failed`、`cancelled`、`timed_out`。任务保存在内存中，server 进程结束后不能查询或恢复；取消和超时不会撤销已经写入工作区的文件。

## 配置与边界

| 环境变量 | 含义 | 默认值 |
| --- | --- | --- |
| `DSH_MCP_WORKSPACE_ROOTS` | 允许接受任务的绝对目录数组，JSON；必填 | 无 |
| `DSH_MCP_COMMAND` | 官方 harness 的可执行文件路径或命令名 | `dsh` |
| `DSH_MCP_ARGS` | 启动参数数组，JSON | `["--profile","acp"]` |
| `DSH_MCP_MODEL` | 交给 harness 的模型标识 | `deepseek-v4-flash` |
| `DSH_MCP_PROVIDER` | harness 模型 provider 标识 | `deepseek-official` |
| `DSH_MCP_CREDENTIALS_FILE` | 显式引用现有 dsh 凭据存储的绝对路径；由官方 harness 读取 | 不引用 |
| `DSH_MCP_MAX_CONCURRENCY` | 本 server 最大并发任务数，1–8 | `2` |
| `DSH_MCP_TIMEOUT_SECONDS` | 未单独指定时的任务时限，1–3600 秒 | `600` |
| `DEEPSEEK_API_KEY` | 官方 DeepSeek API 凭据，从 MCP 进程环境读取 | 无 |

server 只接受配置根目录及其子目录中的工作区，按真实路径校验；每个任务有独立的临时 harness home，并强制使用 `DSH_PERMISSION_MODE=workspace-write`。默认最多同时运行 2 个任务；同一个或相互嵌套的工作区不能并发执行。该锁仅覆盖单个 server 进程，不协调多个客户端启动的独立实例。

`allowed_paths` 是交给 worker 的改动范围指令，**不是按文件强制的访问沙箱**。任务入口校验也不等于约束每条 shell 命令；实际运行隔离依赖官方 harness 的操作系统沙箱。客户端自身的沙箱不会自动传递给 MCP 子进程。需要严格按文件隔离时，应使用单独 checkout/受控运行环境，不能仅依赖提示词。

任务默认上限 600 秒，最大 3600 秒；等待权限也计入上限。模型身份和可用性以实际 DeepSeek 账户与 harness 支持为准，修改环境变量不会替用户开通模型权限。

更多实现边界与协议来源见 [架构说明](docs/architecture.md)，完整分派与权限示例见 [使用说明](docs/delegation.md)。

真实 Codex → MCP → Flash 的已完成验证和可复验产物见 [真实调用记录](docs/live-verification.md)。

## 开发

```bash
npm run check
npm run build
npm test
npm run check:package
```

`npm install` / `npm ci` 会通过 `prepare` 构建 CLI，直接从 Git 仓库安装也会生成 `dist/index.js`。`check:package` 在不含预生成 `dist` 的临时源码仓库上走真实 Git 依赖打包流程，并验证 CLI 可启动；需先安装依赖，检查离线复用 npm 缓存。CI 同时运行该检查。

测试使用本地 ACP 测试替身时不需要 API 密钥。真实 DeepSeek 调用另需凭据、网络和账户额度；通过协议测试并不代表已完成真实模型端到端验证。

已独立安装官方 harness 时，可运行完整工具链冒烟测试：

```bash
DSH_SMOKE_COMMAND=/absolute/path/to/dsh npm run test:harness
```

该测试用真实 harness 连接临时本地模型服务，通过 MCP 提交任务、选择 Flash 路由、执行原生文件写入，再用 bash 读取校验；只用虚构凭据，不调用外部模型、不产生 API 费用。它验证真实 harness 集成，不能证明真实 DeepSeek 账户和网络已可用。当前本机运行验证基于 macOS，CI 配置覆盖 Linux/macOS；Windows 尚未验证。

## 官方参考

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方 ACP 协议桥接器](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp)
- [官方 ACP application profile](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/acp-app)
- [Claude Desktop 本地 MCP 配置](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Cursor MCP 配置](https://prod.cursor.com/docs/mcp) / [Agent Skills](https://prod.cursor.com/docs/skills)
- [OpenAI Docs：Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) / [Build skills](https://learn.chatgpt.com/docs/build-skills)
