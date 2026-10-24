import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';

export interface TaskInput {
  workspace: string;
  objective: string;
  allowed_paths: string[];
  constraints?: string[];
  acceptance_checks?: string[];
  timeout_seconds?: number;
}

export type TaskStatus = 'starting' | 'running' | 'awaiting_permission' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface WorkerHooks {
  ready(sessionId: string, model: string): void;
  update(notification: SessionNotification): void;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export interface Worker {
  run(input: TaskInput): Promise<string>;
  stop(): Promise<void>;
}

export interface PermissionView {
  permission_id: string;
  tool_call: RequestPermissionRequest['toolCall'];
  options: RequestPermissionRequest['options'];
}

export interface TaskView {
  task_id: string;
  workspace: string;
  status: TaskStatus;
  created_at: string;
  finished_at?: string;
  session_id?: string;
  model?: string;
  stop_reason?: string;
  result: string;
  output_truncated: boolean;
  tool_calls: Array<Record<string, unknown>>;
  pending_permissions: PermissionView[];
  error?: string;
}
