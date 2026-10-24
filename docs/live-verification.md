# 真实 Flash 调用验证

2026-10-24，在 macOS 上通过实际 Codex CLI 会话验证；未使用模拟模型服务。

## 调用链

Codex 从用户配置加载 `deepseek-harness` stdio MCP → 本项目服务 → 官方 `@deepseek-ai/dsh@0.2.1-rc.2` ACP profile → 已有 DeepSeek 账号登录 → `deepseek-account/deepseek-flash`。

本次只提交一个任务。MCP task ID：`9a3e03ec-6efe-469d-b9b3-ef785162eedd`，最终状态 `completed`。ACP 返回的模型配置确认了上述 provider/model；这里只记录实际路由标识，不推断后端别名对应的内部模型版本。

任务要求 Flash 创建 `add.mjs`、`add.test.mjs`，实现加法函数，并用 `node:test` 验证 `2+3=5`、`-2+2=0`、`0+0=0`。Flash 完成 7 次工具调用，包括两次原生文件写入和运行测试。Worker 测试为 3 通过、0 失败，无待处理权限。

Codex 随后读取了真实文件并独立运行相同测试，仍为 3 通过、0 失败、0 跳过、退出码 0。测试产物已从临时工作目录移至 [examples/live-flash-verification](../examples/live-flash-verification)，可以复验：

```bash
node --test examples/live-flash-verification/add.test.mjs
```

凭据由官方 harness 通过显式引用的原存储解析；未将密钥或账号令牌导出到 MCP 配置、环境变量或本报告。账号正常刷新仍由官方 credentials provider 管理。

任务数据仅存在于那次 MCP 进程中；临时 Codex 会话退出后，上述 task ID 不再支持查询，测试产物与本记录作为验收证据保留。

同期本地回归：`npm test` 28/28 通过，无失败、跳过或取消；覆盖新增凭据引用及已有 MCP/ACP 生命周期。
