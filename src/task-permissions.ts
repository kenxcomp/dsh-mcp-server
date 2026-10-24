import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';

type Scope = 'within_scope' | 'widening' | 'unknown';

function scope(input: unknown): Scope {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
  const args = input as Record<string, unknown>;
  if (!Object.hasOwn(args, 'sandbox_permissions')) return 'within_scope';
  return args.sandbox_permissions === 'workspace-write' || args.sandbox_permissions === 'read-only'
    ? 'within_scope' : 'widening';
}

/** Preserve only a bounded scope decision from complete, untruncated ACP inputs. */
export class TaskPermissions {
  private calls = new Map<string, Scope>();

  observe(update: SessionNotification['update']): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    if (!Object.hasOwn(update, 'rawInput') && update.sessionUpdate === 'tool_call_update') return;
    if (!this.calls.has(update.toolCallId) && this.calls.size >= 128) {
      this.calls.delete(this.calls.keys().next().value!);
    }
    this.calls.set(update.toolCallId, scope(update.rawInput));
  }

  mayAsk(request: RequestPermissionRequest): boolean {
    const previous = this.calls.get(request.toolCall.toolCallId);
    if (previous === 'widening') return false;
    if (Object.hasOwn(request.toolCall, 'rawInput')) {
      return scope(request.toolCall.rawInput) === 'within_scope';
    }
    return previous === 'within_scope';
  }
}
