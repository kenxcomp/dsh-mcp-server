import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpWorker } from './acp-worker.js';
import { workspace, type Config } from './config.js';
import { contains } from './paths.js';
import { redact, redactValue, SecretStream } from './redaction.js';
import type { PermissionView, TaskInput, TaskStatus, TaskView, Worker, WorkerHooks } from './types.js';

interface Pending extends PermissionView {
  resolve(response: RequestPermissionResponse): void;
}

interface RecordState {
  view: TaskView;
  worker: Worker;
  permissions: Map<string, Pending>;
  done: Promise<void>;
  output: SecretStream;
  stopAs?: TaskStatus;
}

const FINAL = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'timed_out']);
const OUTPUT_LIMIT = 64_000;
const TOOL_LIMIT = 100;

export class TaskManager {
  private records = new Map<string, RecordState>();
  private quarantined = new Set<string>();
  private closing = false;
  // Serialize admission (not execution) across asynchronous realpath checks.
  private admissions: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: Config,
    private readonly factory: (hooks: WorkerHooks) => Worker = hooks => new AcpWorker(config, hooks)) {}

  submit(input: TaskInput): Promise<TaskView> {
    const result = this.admissions.then(() => this.admit(input));
    this.admissions = result.catch(() => {});
    return result;
  }

  private async admit(input: TaskInput): Promise<TaskView> {
    if (this.closing) throw new Error('Server is shutting down');
    const canonical = await workspace(this.config, input.workspace);
    if (this.closing) throw new Error('Server is shutting down');
    if ([...this.quarantined].some(path => contains(path, canonical) || contains(canonical, path))) {
      throw new Error('Workspace has an unreaped worker; restart the server and inspect processes before reuse');
    }
    for (const path of input.allowed_paths) {
      if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
        throw new Error('allowed_paths must be workspace-relative paths without parent traversal');
      }
    }
    const active = [...this.records.values()].filter(record => !FINAL.has(record.view.status));
    if (active.length >= this.config.concurrency) throw new Error('Worker capacity reached; wait for an active task');
    if (active.some(record => contains(record.view.workspace, canonical) || contains(canonical, record.view.workspace))) {
      throw new Error('An overlapping workspace already has an active task; serialize writes or use an independent checkout');
    }
    if (this.records.size >= this.config.maxTasks) {
      const oldest = [...this.records.values()].find(record => FINAL.has(record.view.status));
      if (oldest) this.records.delete(oldest.view.task_id);
      else throw new Error('Task retention limit reached');
    }
    const taskId = randomUUID();
    const record: RecordState = {
      view: { task_id: taskId, workspace: canonical, status: 'starting', created_at: new Date().toISOString(),
        result: '', output_truncated: false, tool_calls: [], pending_permissions: [] },
      permissions: new Map(),
      output: new SecretStream(this.config.childEnv),
      worker: undefined!,
      done: Promise.resolve(),
    };
    record.worker = this.factory({
      ready: (sessionId, model, reasoningEffort) => {
        record.view.session_id = sessionId;
        record.view.model = model;
        if (reasoningEffort !== undefined) record.view.reasoning_effort = reasoningEffort;
        record.view.status = record.permissions.size ? 'awaiting_permission' : 'running';
      },
      update: notification => this.update(record, notification),
      permission: request => this.permission(record, request),
    });
    this.records.set(taskId, record);
    record.done = this.execute(record, { ...input, workspace: canonical });
    return this.snapshot(record);
  }

  private async execute(record: RecordState, input: TaskInput): Promise<void> {
    const timeout = setTimeout(() => { void this.requestStop(record, 'timed_out'); },
      (input.timeout_seconds ?? this.config.timeoutSeconds) * 1000);
    let status: TaskStatus = 'failed';
    try {
      const reason = await record.worker.run(input);
      record.view.stop_reason = reason;
      if (reason === 'end_turn') status = 'completed';
      else if (reason === 'cancelled') status = 'cancelled';
      else record.view.error = `Harness stopped before completion: ${reason}`;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : 'Harness task failed', this.config.childEnv);
      const marker = '\n[diagnostic truncated]\n';
      record.view.error = message.length > 4096
        ? message.slice(0, 1024) + marker + message.slice(-(4096 - 1024 - marker.length))
        : message;
    } finally {
      clearTimeout(timeout);
      this.appendOutput(record, record.output.end());
      this.cancelPermissions(record);
      try { await record.worker.stop(); }
      catch {
        this.quarantined.add(record.view.workspace);
        status = 'failed';
        record.view.error = 'Harness cleanup failed; inspect worker processes before reusing this workspace';
      }
      record.view.status = record.stopAs ?? status;
      record.view.finished_at = new Date().toISOString();
    }
  }

  private update(record: RecordState, notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.appendOutput(record, record.output.write(update.content.text));
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const safe = this.safeObject(update);
      const previous = record.view.tool_calls.find(tool => tool.toolCallId === update.toolCallId);
      if (previous) Object.assign(previous, safe);
      else {
        if (record.view.tool_calls.length >= TOOL_LIMIT) record.view.tool_calls.shift();
        record.view.tool_calls.push(safe);
      }
    }
  }

  private appendOutput(record: RecordState, text: string): void {
    const remaining = OUTPUT_LIMIT - record.view.result.length;
    record.view.result += text.slice(0, remaining);
    if (text.length > remaining) record.view.output_truncated = true;
  }

  private safeObject(value: object): Record<string, unknown> {
    const json = JSON.stringify(redactValue(value, this.config.childEnv));
    return json.length <= 8192 ? JSON.parse(json) as Record<string, unknown>
      : { toolCallId: (value as { toolCallId?: string }).toolCallId, detail: json.slice(0, 8192), truncated: true };
  }

  private permission(record: RecordState, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (record.stopAs || record.permissions.size >= 16) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const permissionId = randomUUID();
    const context = record.view.tool_calls.find(tool => tool.toolCallId === request.toolCall.toolCallId);
    record.view.status = 'awaiting_permission';
    return new Promise(resolve => {
      record.permissions.set(permissionId, {
        permission_id: permissionId,
        tool_call: { ...context, ...request.toolCall },
        options: request.options,
        resolve,
      });
    });
  }

  private cancelPermissions(record: RecordState): void {
    for (const permission of record.permissions.values()) permission.resolve({ outcome: { outcome: 'cancelled' } });
    record.permissions.clear();
  }

  respond(taskId: string, permissionId: string, decision: 'allow_once' | 'reject_once'): TaskView {
    const record = this.require(taskId);
    const permission = record.permissions.get(permissionId);
    if (!permission || record.stopAs) throw new Error('Permission is not pending for this task');
    const option = permission.options.find(item => item.kind === decision);
    if (!option) throw new Error('Harness did not offer this one-shot permission choice');
    record.permissions.delete(permissionId);
    permission.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
    record.view.status = record.permissions.size ? 'awaiting_permission' : 'running';
    return this.snapshot(record);
  }

  async get(taskId: string, waitMs = 0): Promise<TaskView> {
    const record = this.require(taskId);
    if (waitMs && !FINAL.has(record.view.status) && !record.permissions.size) {
      const controller = new AbortController();
      try { await Promise.race([record.done, delay(waitMs, undefined, { signal: controller.signal })]); }
      finally { controller.abort(); }
    }
    return this.snapshot(record);
  }

  list(): Array<Omit<TaskView, 'result' | 'tool_calls' | 'pending_permissions'> & { pending_permission_count: number }> {
    return [...this.records.values()].map(record => {
      const { result: _result, tool_calls: _calls, pending_permissions, ...summary } = this.snapshot(record);
      return { ...summary, pending_permission_count: pending_permissions.length };
    });
  }

  async cancel(taskId: string): Promise<TaskView> {
    const record = this.require(taskId);
    await this.requestStop(record, 'cancelled');
    await record.done;
    return this.snapshot(record);
  }

  private async requestStop(record: RecordState, status: TaskStatus): Promise<void> {
    if (FINAL.has(record.view.status)) return;
    record.stopAs ??= status;
    this.cancelPermissions(record);
    try { await record.worker.stop(); }
    catch { record.view.error = 'Harness did not stop cleanly'; }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.admissions;
    await Promise.all([...this.records.keys()].map(id => this.cancel(id)));
  }

  private require(taskId: string): RecordState {
    const record = this.records.get(taskId);
    if (!record) throw new Error('Unknown task_id (tasks live only in this MCP server process)');
    return record;
  }

  private snapshot(record: RecordState): TaskView {
    const view = { ...record.view, pending_permissions: [...record.permissions.values()].map(({ resolve: _resolve, ...permission }) => permission) };
    return redactValue(view, this.config.childEnv) as TaskView;
  }
}
