import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, submit, waitTask, call, data, assertError, repo, terminal } from './helpers.mjs';

const fixture = join(repo, 'tests/fixtures/task-permission-agent.mjs');

async function context(t) {
  return setup(t, { DSH_MCP_ARGS: JSON.stringify([fixture]) });
}

function denied() { return { outcome: 'selected', optionId: 'no-once' }; }

test('task scope automatically rejects widening and missing or invalid permission context before public clipping', async t => {
  const ctx = await context(t);
  const started = await submit(ctx, 'scope:auto-cases', { allowed_paths: ['.scope-fixture.json'] });
  const finished = await waitTask(ctx, started.task_id, task =>
    terminal.has(task.status) || task.status === 'awaiting_permission');
  assert.equal(finished.status, 'completed', 'Unsafe permission must not become a user-approvable pending request');
  assert.deepEqual(JSON.parse(finished.result), {
    largeDanger: denied(), unknownMode: denied(), arrayInput: denied(), stringInput: denied(), noContext: denied(),
    noRejectChoice: { outcome: 'cancelled' }, updateWithoutInput: denied(), updateWithDanger: denied(),
    inlineCannotOverride: denied(), inlineDanger: denied(), inlineNull: denied(),
  });
  assert.deepEqual(finished.pending_permissions, []);
  assert.equal(finished.tool_calls.find(tool => tool.toolCallId === 'large-danger').truncated, true);
  assertError(await call(ctx.client, 'dsh_respond_permission', {
    task_id: started.task_id, permission_id: randomUUID(), decision: 'allow_once',
  }), /not pending/);
  const runtime = JSON.parse(await readFile(join(ctx.root, '.scope-fixture.json'), 'utf8'));
  assert.equal(runtime.spawnCwd, started.workspace);
  assert.equal(runtime.sessionCwd, started.workspace);
  assert.equal(runtime.patchMode, 0o600);
  assert.deepEqual(runtime.patch.find(row => row.id === 'sandbox-policy').config, {
    mode: 'workspace-write', workspaceRoot: started.workspace, additionalWritableRoots: [],
  });
  assert.deepEqual(runtime.patch.find(row => row.id === 'acp').config, {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
  });
  assert.equal(ctx.stderr(), '');
});

test('ordinary and workspace-write permission requests preserve explicit one-shot approval and rejection', async t => {
  const ctx = await context(t);
  const started = await submit(ctx, 'scope:normal', {
    allowed_paths: ['approved.txt', 'rejected.txt', '.scope-fixture.json'],
  });
  const pending = await waitTask(ctx, started.task_id, task => task.status === 'awaiting_permission');
  assert.equal(pending.pending_permissions.length, 1);
  assert.equal(pending.pending_permissions[0].tool_call.toolCallId, 'normal-write');
  data(await call(ctx.client, 'dsh_respond_permission', {
    task_id: started.task_id, permission_id: pending.pending_permissions[0].permission_id, decision: 'allow_once',
  }));
  const second = await waitTask(ctx, started.task_id, task =>
    task.pending_permissions.some(permission => permission.tool_call.toolCallId === 'workspace-write'));
  data(await call(ctx.client, 'dsh_respond_permission', {
    task_id: started.task_id, permission_id: second.pending_permissions[0].permission_id, decision: 'reject_once',
  }));
  const finished = await waitTask(ctx, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.deepEqual(JSON.parse(finished.result), {
    normal: { outcome: 'selected', optionId: 'yes-once' }, workspaceWrite: denied(),
  });
  assert.equal(await readFile(join(ctx.root, 'approved.txt'), 'utf8'), 'approved fixture');
  await assert.rejects(access(join(ctx.root, 'rejected.txt')), { code: 'ENOENT' });
});

test('permission context evicted by the bounded guard fails closed', async t => {
  const ctx = await context(t);
  const started = await submit(ctx, 'scope:capacity', { allowed_paths: ['.scope-fixture.json'] });
  const finished = await waitTask(ctx, started.task_id, task =>
    terminal.has(task.status) || task.status === 'awaiting_permission');
  assert.equal(finished.status, 'completed');
  assert.deepEqual(JSON.parse(finished.result), { evictedContext: denied() });
  assert.deepEqual(finished.pending_permissions, []);
  assert.ok(finished.tool_calls.length <= 100);
});

test('a complete inline permission context can be approved within the task scope', async t => {
  const ctx = await context(t);
  const started = await submit(ctx, 'scope:inline', { allowed_paths: ['inline.txt', '.scope-fixture.json'] });
  const pending = await waitTask(ctx, started.task_id, task => task.status === 'awaiting_permission');
  assert.equal(pending.pending_permissions.length, 1);
  assert.equal(pending.pending_permissions[0].tool_call.toolCallId, 'inline-write');
  assert.deepEqual(pending.pending_permissions[0].tool_call.rawInput, {
    file_path: 'inline.txt', sandbox_permissions: 'workspace-write',
  });
  data(await call(ctx.client, 'dsh_respond_permission', {
    task_id: started.task_id, permission_id: pending.pending_permissions[0].permission_id, decision: 'allow_once',
  }));
  const finished = await waitTask(ctx, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.deepEqual(JSON.parse(finished.result), { inline: { outcome: 'selected', optionId: 'yes-once' } });
  assert.equal(await readFile(join(ctx.root, 'inline.txt'), 'utf8'), 'approved inline fixture');
});
