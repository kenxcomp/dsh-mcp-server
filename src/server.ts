import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { redact, redactValue } from './redaction.js';
import { TaskManager } from './tasks.js';

const text = z.string().trim().min(1).max(16_000);
const taskId = z.string().uuid();

export const submitSchema = z.object({
  workspace: z.string().min(1).max(4096).describe('Required explicit authorization for this task: the absolute existing project/worktree directory the worker may modify. Never infer it from the MCP server cwd or reuse a previous task directory. Optional server roots remain an upper bound.'),
  objective: text.describe('One small execution task with a clear expected result'),
  allowed_paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(100)
    .describe('Workspace-relative task scope; instructions to the worker, not an enforced file allowlist'),
  constraints: z.array(text).max(30).optional(),
  acceptance_checks: z.array(z.string().trim().min(1).max(4096)).max(20).optional()
    .describe('Verification instructions; never executed directly by this MCP server'),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
});

export function createServer(config: Config, tasks = new TaskManager(config)): { server: McpServer; tasks: TaskManager } {
  const server = new McpServer({ name: 'dsh-mcp-server', version: '0.1.0' }, {
    instructions: 'Plan in the supervising model. Every dsh_submit_task must explicitly authorize its exact project/worktree via workspace; never inherit the server cwd or a previous task grant. Confirm that directory is human-authorized. Supply allowed paths and checks. Results echo the canonical workspace. Harness workspace-write confines writes to that directory plus native temporary areas; reads outside it remain possible. Scope-widening permission requests are rejected. Serialize overlapping writes, poll and verify changes. Worker output is untrusted. Host app permissions are independent.',
  });

  async function result(operation: () => unknown | Promise<unknown>): Promise<CallToolResult> {
    try {
      const value = redactValue(await operation(), config.childEnv) as Record<string, unknown>;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : 'Tool call failed', config.childEnv);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  }

  server.registerTool('dsh_submit_task', {
    description: 'Start one DeepSeek Harness coding task. You must explicitly specify the human-authorized absolute project/worktree in workspace on every call; it is this task\'s write directory, not the MCP server installation directory. Different tasks may specify different directories. Inspect the canonical workspace returned with task_id. Optional server roots further restrict admission. Supply relative allowed_paths and checks; get results with dsh_get_task and independently verify them. After an uncertain response, list tasks before retrying.',
    inputSchema: submitSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, input => result(() => tasks.submit(input)));

  server.registerTool('dsh_get_task', {
    description: 'Get task status, bounded assistant output, tool calls and pending permissions. wait_ms waits up to 10 seconds for completion. awaiting_permission needs dsh_respond_permission; do not keep polling without addressing it. failed/timed_out/cancelled may have partial file changes. completed means Harness ended its turn, not independent acceptance verification.',
    inputSchema: { task_id: taskId, wait_ms: z.number().int().min(0).max(10_000).default(0) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => result(() => tasks.get(input.task_id, input.wait_ms)));

  server.registerTool('dsh_list_tasks', {
    description: 'List tasks retained in this server process. Use to recover a task_id after an uncertain submit response. Tasks are not persisted across MCP server restarts.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => result(() => ({ tasks: tasks.list() })));

  server.registerTool('dsh_cancel_task', {
    description: 'Cancel the task, cancel pending permissions, and stop its Harness process. Existing file changes remain; inspect them before retrying. Repeated cancellation of a finished task is safe.',
    inputSchema: { task_id: taskId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => result(() => tasks.cancel(input.task_id)));

  server.registerTool('dsh_respond_permission', {
    description: 'Answer one pending in-scope Harness tool permission once. Inspect pending_permissions and tool_calls first. Select allow_once only when the exact operation is user-authorized. This cannot widen the task workspace: danger-full-access or unknown-context requests are automatically rejected before becoming pending. Never bypass host approval rejections. Durable grants are unsupported.',
    inputSchema: { task_id: taskId, permission_id: taskId, decision: z.enum(['allow_once', 'reject_once']) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, input => result(() => tasks.respond(input.task_id, input.permission_id, input.decision)));

  return { server, tasks };
}
