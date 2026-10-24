# 架构与运行边界

## 领域职责

本项目让 MCP 客户端将本地工程执行任务交给官方 DeepSeek Harness。主 agent 的模型选择、规划、用户沟通和最终验收仍属于客户端；桥接器拥有任务状态和进程生命周期；harness 拥有模型循环、执行工具及运行权限决策请求。

```text
主 agent
  │ dsh_submit_task / dsh_get_task / dsh_respond_permission
  ▼
MCP stdio server
  │ 校验工作区、并发与时限；保存本进程任务状态
  ▼
每任务独立的 ACP client + dsh 子进程 + 临时 DSH_HOME
  │ initialize → session/new → session/set_config_option → session/prompt
  ▼
官方 ACP application → DeepSeek provider → 模型与 harness 工具
```

本项目只提供本地 stdio transport，不启动 HTTP 端口，不提供多用户远程服务。接入者是当前 OS 用户启动的客户端；本地进程权限、DeepSeek 账户及工作区归属构成实际隔离边界。不要把它直接暴露成共享远程服务。

## 为什么使用 ACP

官方 harness 的 [ACP 插件](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) 提供代理会话和流式事件入口；[ACP application](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/acp-app) 负责装配可运行的 agent。桥接器从 MCP 接收任务，通过 ACP 的初始化、创建会话和提交 prompt 驱动真实 harness。

因此 MCP 客户端得到的是带文件、终端等能力的 agent 任务，而非仅发送一条 DeepSeek Chat API 消息。harness 自身可以消费 MCP 工具，但“消费 MCP”与“作为 MCP 工具被其他客户端调用”是两个方向；本项目承担后一个方向。

开发目标版本为官方 npm `@deepseek-ai/dsh@0.2.1-rc.2`。公开源码 `master` 会继续变化，不能把源码最新功能等同于所有 npm 版本的能力。自定义 `DSH_MCP_COMMAND`、`DSH_MCP_ARGS` 适合指向已验证的安装或源码构建，不会自动验证任意第三方 launcher 的兼容性。

## 异步任务

`dsh_submit_task` 返回任务 ID。worker 的运行时间不占据一个长时间挂起的 MCP 调用；客户端通过最长 10 秒的 `dsh_get_task` 等待检查进度。这样也允许客户端在运行中处理权限和取消。

任务状态从 `starting` 进入 `running`，需要权限时进入 `awaiting_permission`；结束状态为 `completed`、`failed`、`cancelled` 或 `timed_out`。状态和结果属于当前 server 进程，关闭后不提供持久化恢复。

每任务有截止时间（默认 600 秒，最多 3600 秒），等待权限也占用任务时间。取消、超时和关闭需要结束对应 harness 进程并清理临时资源；它们不会事务性回滚已发生的工作区修改。失败后应先检查实际 diff，再决定是否重新提交任务，避免重复副作用。

保留最近最多 100 个任务；超过上限时移除最早结束的任务。每任务最多返回 64,000 字符的 assistant 输出，截断时 `output_truncated=true`，工具记录最多保留 100 条；每次工具更新最多约 8,192 字符，同一工具的更新会合并。`dsh_list_tasks` 只返回摘要，详细结果和权限使用 `dsh_get_task` 获取。stdout 仅用于 MCP；worker stderr 有界保存并脱敏后用于失败诊断。跨通知片段的密钥前缀先缓冲再发布，避免中途查询泄漏。

## 工作区、并发和文件范围

每次 `dsh_submit_task.workspace` 是本次人类任务授权的具体项目或 worktree 目录，不能缺省或继承 server cwd、安装目录、先前任务的目录。server 要求绝对、已有目录，拒绝文件系统根目录，并规范化真实路径。返回的 `TaskView.workspace` 回显该目录，供主 agent 核对。不同任务可以授权不同目录。

`DSH_MCP_WORKSPACE_ROOTS` 仅是可选的管理员上限。未配置时按每任务明确的 `workspace` 授权；配置时要求非空目录数组，再执行包含校验，不能通过相似前缀或逃逸符号链接绕过上限。显式 `[]` 拒绝，而非解释为不设上限。

每任务独立的进程启动 cwd、ACP `session/new.cwd` 和临时 profile 中的 `sandbox-policy.workspaceRoot` 使用同一个规范化目录。profile 固定 `workspace-write`，`additionalWritableRoots` 为空；不附加父仓库或 linked worktree 的外部共享 `.git`。目录入口上限不会被当成任务的写权限根，因此两个位于同一管理员上限下的任务也不共享目录授权。

启动 profile 不放在原生沙箱可写的共享临时区域内。MCP 在 `~/.local/state/dsh-mcp-server/runs`（可由 `DSH_MCP_RUNTIME_ROOT` 指定）创建独立 `0700` 控制目录作为本次 `DSH_HOME`，profile 权限为 `0600`，结束后移除。运行根必须归当前用户所有、仅所有者可访问，且不能是符号链接、位于原生临时写区域内或与任务工作区交叠。这样保留临时数据写入能力，同时把启动策略从任务的可写数据区域中分离。目录外读取仍按原生能力开放，不宣称同一 OS 用户下的读取隔离。

实际写入限制依赖官方 harness 的文件和操作系统沙箱，并保留其平台临时区写入例外。`workspace-write` 不限制目录外读取，不能宣称严格的读写隔离。启动 MCP 的客户端沙箱不会自动覆盖外部 server 或其子进程；需要严格读写隔离时须另行使用受控运行环境。

`allowed_paths`、`constraints` 和 `acceptance_checks` 会进入 worker prompt。`allowed_paths` 是任务意图约束，不能充当强制文件访问控制；`acceptance_checks` 不由桥接器解释或直接执行。需要强隔离时使用受控 checkout、容器或 OS 权限等真实边界，再由主 agent 检查 diff。

默认最多同时运行 2 个任务；同工作区或互相嵌套的工作区不能并行。检查覆盖该 server 的所有活跃任务，但不覆盖不同 Claude Desktop、Cursor、Codex 实例各自启动的 server。跨实例操作同一 checkout 需要外部协调；主 agent 应串行写任务，独立 checkout 才并行。

## 权限和凭据

每个任务创建独立临时 `DSH_HOME`，不复用用户 profile 或会话。凭据有两条显式路径：API key 从可信 MCP 进程环境提供；或通过 `DSH_MCP_CREDENTIALS_FILE` 引用现有官方凭据存储。未设置该变量时不自动读取用户 `~/.dsh` 的存储。API key 示例借助 Node `--env-file` 读取仓库外的受保护环境文件，客户端配置本身不包含密钥。

每任务临时 `profiles/acp/cordis.patch.yml` 都写入 JSON（合法的 YAML 子集），固定本次 `sandbox-policy` 和 `acp` 的初始 provider/model。引用存储时，桥接器仅校验绝对路径、常规文件、当前用户归属及 POSIX owner-only 权限，不读取或解析文件内容；另把 `credentials` provider 的 `path` 指向该文件，并关闭该 worker 的文件 watcher。原凭据不复制到临时 home，也不由桥接器导出为环境变量。

官方 harness 负责读取和解析该存储，以及正常的账号刷新；刷新可能写回原文件，由其跨进程写锁协调。临时 home 的会话隔离不代表凭据存储隔离。此模式应仅指向当前用户授权使用的存储，不能据此把本服务当成其他用户的账号代理。

ACP 权限先经过任务范围校验。worker 从完整、未截断的 `tool_call` 输入保存有界的范围判断；不能用已截断的返回记录判断权限。请求扩大到 `danger-full-access` 或未知模式时自动拒绝，缺失或无法确认完整输入上下文时同样拒绝，不能通过 `dsh_respond_permission` 扩大本次目录。

正常的范围内 ACP 权限请求被映射为 `pending_permissions`。桥接器不因 worker 文本声称“已授权”就批准；上层 agent 检查具体请求与用户授权，随后对该请求使用 `allow_once` 或 `reject_once`。没有批量永久授权。来自 worker 的内容、工具活动及权限描述均是待检查的数据，不能提升其优先级覆盖用户或客户端约束。

模型和 provider 默认固定为 `deepseek-v4-flash` / `deepseek-official`；可由 server 环境配置更改。官方 API key 和 dsh 账号登录是两种认证路径，账号登录示例使用 `deepseek-account` / `deepseek-flash`，按对应账号额度和计费规则调用。两条路径都必须匹配实际广告的模型选项，不做静默回退。主客户端用什么模型不在桥接器控制范围内。账户权限、网络可达性、模型计费和可用性仍由实际服务决定。

## 验证范围

本地 ACP 替身测试验证 MCP/ACP 生命周期、输入边界和故障处理时，无需 DeepSeek 凭据。真实 harness 的协议握手测试能验证 launcher 和会话能力，但不能替代付费模型执行测试。发布或运行结果应分别说明本地协议测试、真实 harness 握手和真实模型调用各自是否完成。
