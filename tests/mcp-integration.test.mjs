import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, call, data, submit, waitTask, assertError, fixtureKey } from './helpers.mjs';

test('MCP discovers five tools and executes a scoped task through advertised Flash route', async t => {
  const context = await setup(t);
  const tools = await context.client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
    'dsh_cancel_task', 'dsh_get_task', 'dsh_list_tasks', 'dsh_respond_permission', 'dsh_submit_task',
  ]);
  assert.match(context.client.getInstructions(), /Plan in the supervising model/);
  const started = await submit(context, 'fixture:normal', { acceptance_checks: ['acceptance sentinel'] });
  assert.ok(['starting', 'running'].includes(started.status));
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.model, 'deepseek-official/deepseek-v4-flash');
  assert.match(finished.result, /selected:\["deepseek-official","deepseek-v4-flash"\]/);
  assert.match(finished.result, /acceptance instructions received/);
  assert.equal(await readFile(join(context.root, 'result.txt'), 'utf8'), 'fixture verified\n');
  const runtime = JSON.parse(await readFile(join(context.root, '.fixture-runtime.json'), 'utf8'));
  assert.equal(runtime.permissionMode, 'workspace-write');
  assert.equal(runtime.leakedOtherToken, false);
  await assert.rejects(access(runtime.home), { code: 'ENOENT' });
  const list = data(await call(context.client, 'dsh_list_tasks'));
  assert.equal(list.tasks[0].task_id, started.task_id);
  assert.equal(context.stderr(), '');
  assert.deepEqual(context.errors, []);
});

for (const [decision, answer] of [['allow_once', 'yes-once'], ['reject_once', 'no-once']]) {
  test(`ACP permission remains pending until explicit ${decision} and cannot be replayed`, async t => {
    const context = await setup(t);
    const started = await submit(context, 'fixture:permission');
    const pending = await waitTask(context, started.task_id, task => task.status === 'awaiting_permission');
    assert.equal(pending.pending_permissions.length, 1);
    const permission = pending.pending_permissions[0];
    assert.equal(permission.tool_call.title, 'Write fixture output');
    assert.deepEqual(permission.tool_call.rawInput, { path: 'result.txt' });
    const args = { task_id: started.task_id, permission_id: permission.permission_id, decision };
    data(await call(context.client, 'dsh_respond_permission', args));
    const finished = await waitTask(context, started.task_id);
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(finished.result, `permission:${answer}`);
    assert.equal(finished.tool_calls[0].status, 'completed');
    assert.equal(finished.pending_permissions.length, 0);
    assertError(await call(context.client, 'dsh_respond_permission', args), /not pending/);
  });
}

test('same and nested workspaces reject concurrent admission, cancel releases workspace', async t => {
  const context = await setup(t);
  const nested = join(context.root, 'nested');
  await mkdir(nested);
  const first = await submit(context, 'fixture:hang');
  await waitTask(context, first.task_id, task => task.status === 'running');
  assertError(await call(context.client, 'dsh_submit_task', {
    workspace: context.root, objective: 'fixture:normal', allowed_paths: ['.'],
  }), /overlapping workspace/);
  assertError(await call(context.client, 'dsh_submit_task', {
    workspace: nested, objective: 'fixture:normal', allowed_paths: ['.'],
  }), /overlapping workspace/);
  const cancelled = data(await call(context.client, 'dsh_cancel_task', { task_id: first.task_id }));
  assert.equal(cancelled.status, 'cancelled');
  const again = data(await call(context.client, 'dsh_cancel_task', { task_id: first.task_id }));
  assert.equal(again.status, 'cancelled');
  const next = await submit(context, 'fixture:normal');
  assert.equal((await waitTask(context, next.task_id)).status, 'completed');
});

test('independent workspaces run concurrently with isolated homes and bounded capacity', async t => {
  const context = await setup(t);
  const a = join(context.root, 'a');
  const b = join(context.root, 'b');
  const c = join(context.root, 'c');
  await Promise.all([mkdir(a), mkdir(b), mkdir(c)]);
  const [left, right] = await Promise.all([
    submit(context, 'fixture:hang', { workspace: a }), submit(context, 'fixture:hang', { workspace: b }),
  ]);
  await Promise.all([left, right].map(task => waitTask(context, task.task_id, value => value.status === 'running')));
  const [runtimeA, runtimeB] = await Promise.all([a, b].map(async path =>
    JSON.parse(await readFile(join(path, '.fixture-runtime.json'), 'utf8'))));
  assert.notEqual(runtimeA.home, runtimeB.home);
  assert.notEqual(runtimeA.pid, runtimeB.pid);
  assertError(await call(context.client, 'dsh_submit_task', {
    workspace: c, objective: 'fixture:normal', allowed_paths: ['.'],
  }), /capacity reached/);
  await Promise.all([left, right].map(task => call(context.client, 'dsh_cancel_task', { task_id: task.task_id })));
});

test('task deadline stops a non-completing prompt and clears permissions on cancellation', async t => {
  const context = await setup(t);
  const timed = await submit(context, 'fixture:hang', { timeout_seconds: 1 });
  assert.equal((await waitTask(context, timed.task_id)).status, 'timed_out');
  const permission = await submit(context, 'fixture:permission');
  await waitTask(context, permission.task_id, task => task.status === 'awaiting_permission');
  const cancelled = data(await call(context.client, 'dsh_cancel_task', { task_id: permission.task_id }));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.pending_permissions.length, 0);
});

test('canonical workspace validation blocks outside and escaping symlink paths', async t => {
  const context = await setup(t);
  const escape = join(context.root, 'escape');
  await symlink(context.outside, escape, 'dir');
  for (const workspace of [context.outside, escape]) {
    assertError(await call(context.client, 'dsh_submit_task', {
      workspace, objective: 'fixture:normal', allowed_paths: ['.'],
    }), /outside DSH_MCP_WORKSPACE_ROOTS/);
  }
  assertError(await call(context.client, 'dsh_submit_task', {
    workspace: context.root, objective: 'fixture:normal', allowed_paths: ['../outside'],
  }), /parent traversal/);
  assertError(await call(context.client, 'dsh_get_task', { task_id: randomUUID() }), /Unknown task_id/);
  assertError(await call(context.client, 'dsh_submit_task', {
    workspace: context.root, objective: '', allowed_paths: [],
  }), /validation|Invalid/i);
});

test('provider credentials are redacted across chunks and structured tool metadata', async t => {
  const context = await setup(t);
  const started = await submit(context, 'fixture:secret');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.ok(!JSON.stringify(finished).includes(fixtureKey));
  assert.match(finished.result, /REDACTED/);
  assert.match(finished.tool_calls[0].title, /REDACTED/);
  assert.ok(!context.stderr().includes(fixtureKey));
});

test('live polling withholds an almost complete secret until the final chunk arrives', async t => {
  const context = await setup(t);
  const started = await submit(context, 'fixture:secret-split');
  await waitTask(context, started.task_id, task =>
    task.tool_calls.some(tool => tool.toolCallId === 'stream-checkpoint'));
  const response = await call(context.client, 'dsh_get_task', { task_id: started.task_id });
  const paused = data(response);
  assert.equal(paused.status, 'running');
  assert.equal(paused.result, 'ordinary prefix: ');
  assert.ok(!JSON.stringify(response).includes(fixtureKey.slice(0, -1)));
  await writeFile(join(context.root, '.fixture-release'), 'continue');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.result, 'ordinary prefix: [REDACTED] safe suffix');
  assert.ok(!JSON.stringify(finished).includes(fixtureKey.slice(0, -1)));
});

test('output-limit boundary cannot expose a truncated credential prefix', async t => {
  const context = await setup(t);
  const started = await submit(context, 'fixture:secret-boundary');
  const paused = await waitTask(context, started.task_id, task =>
    task.tool_calls.some(tool => tool.toolCallId === 'stream-checkpoint'));
  assert.equal(paused.result, 'x'.repeat(63_990));
  assert.ok(!paused.result.includes(fixtureKey.slice(0, 10)));
  await writeFile(join(context.root, '.fixture-release'), 'continue');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.result, 'x'.repeat(63_990) + '[REDACTED]');
  assert.equal(finished.output_truncated, true);
});

test('a stream ending with an incomplete credential retains ordinary text and redacts its tail', async t => {
  const context = await setup(t);
  const started = await submit(context, 'fixture:secret-interrupted');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.result, 'ordinary prefix: [REDACTED]');
  assert.ok(!JSON.stringify(finished).includes(fixtureKey.slice(0, -1)));
});

test('bounded assistant output explicitly reports truncation', async t => {
  const context = await setup(t);
  const started = await submit(context, 'fixture:large');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.result.length, 64_000);
  assert.equal(finished.output_truncated, true);
});

test('worker crash becomes failed task without leaking child stderr credentials', async t => {
  const context = await setup(t);
  const started = await submit(context, 'fixture:crash');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'failed');
  assert.ok(finished.error);
  assert.ok(!JSON.stringify(finished).includes(fixtureKey));
  assert.ok(!context.stderr().includes(fixtureKey));
  assert.equal(context.errors.length, 0);
});

test('crash diagnostics redact secrets before chunk assembly and tail clipping', async t => {
  const context = await setup(t);
  for (const objective of ['fixture:crash-secret-split', 'fixture:crash-secret-window', 'fixture:crash-secret-prefix']) {
    const started = await submit(context, objective);
    const finished = await waitTask(context, started.task_id);
    assert.equal(finished.status, 'failed');
    assert.match(finished.error, /diagnostic sentinel/, objective);
    assert.ok(!finished.error.includes(fixtureKey.slice(0, -1)), objective);
    assert.ok(!finished.error.includes(fixtureKey.slice(-12)), objective);
    assert.ok(!context.stderr().includes(fixtureKey));
  }
});

test('missing advertised model fails before any task prompt or file change', async t => {
  const context = await setup(t, { DSH_MCP_MODEL: 'not-an-advertised-model' });
  const started = await submit(context, 'fixture:normal');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /did not advertise/);
  assert.equal(finished.result, '');
  await assert.rejects(access(join(context.root, 'result.txt')), { code: 'ENOENT' });
});

test('invalid Harness executable returns actionable failed task while MCP remains connected', async t => {
  const context = await setup(t, { DSH_MCP_COMMAND: '/no-such-fixture/harness-executable' });
  const started = await submit(context, 'fixture:normal');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /Could not start Harness|DSH_MCP_COMMAND/);
  assert.equal((await context.client.listTools()).tools.length, 5);
});

test('missing provider credential fails before spawning while MCP discovery remains available', async t => {
  const context = await setup(t, { DEEPSEEK_API_KEY: '' });
  const started = await submit(context, 'fixture:normal');
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /DEEPSEEK_API_KEY/);
  assert.equal(finished.session_id, undefined);
  await assert.rejects(access(join(context.root, '.fixture-runtime.json')), { code: 'ENOENT' });
  assert.equal((await context.client.listTools()).tools.length, 5);
});
