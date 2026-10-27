import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, call, data, submit, waitTask, assertError, fixture } from './helpers.mjs';

function withEffortFixture(t, mode = 'effort:normal') {
  return setup(t, { DSH_MCP_ARGS: JSON.stringify([fixture, mode]) });
}

const allowed_paths = ['result.txt', '.fixture-runtime.json', '.fixture-effort.json', '.fixture-prompt.json'];

async function trace(root, filename = '.fixture-prompt.json') {
  return JSON.parse(await readFile(join(root, filename), 'utf8'));
}

test('task effort is applied through ACP after model selection and isolated between tasks', async t => {
  const context = await withEffortFixture(t);
  for (const effort of ['low', 'max', 'off']) {
    const root = join(context.root, effort);
    await mkdir(root);
    const started = await submit(context, 'fixture:normal', {
      workspace: root, allowed_paths, reasoning_effort: effort,
    });
    const finished = await waitTask(context, started.task_id);
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(finished.reasoning_effort, effort);
    assert.equal(finished.model, 'deepseek-official/deepseek-v4-flash');
    assert.deepEqual(await trace(root), {
      selected: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']),
      effort, effortChanges: [effort],
    });
  }
  const listed = data(await call(context.client, 'dsh_list_tasks')).tasks;
  assert.deepEqual(listed.map(task => task.reasoning_effort), ['low', 'max', 'off']);
});

test('omitting task effort preserves and reports the selected model default without setting it', async t => {
  const context = await withEffortFixture(t);
  const started = await submit(context, 'fixture:normal', { allowed_paths });
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.reasoning_effort, 'high');
  assert.deepEqual((await trace(context.root)).effortChanges, []);
});

test('a model without a reasoning option remains usable when task effort is omitted', async t => {
  const context = await withEffortFixture(t, 'effort:missing');
  const started = await submit(context, 'fixture:normal', { allowed_paths });
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.reasoning_effort, undefined);
  assert.deepEqual((await trace(context.root)).effortChanges, []);
});

for (const [mode, effort, pattern] of [
  ['effort:normal', 'ultra', /advertis|support/i],
  ['effort:missing', 'low', /advertis|support/i],
  ['effort:unconfirmed', 'low', /confirm|requested.*effort/i],
  ['effort:model-changed', 'low', /model|confirm/i],
]) {
  test(`${mode} rejects ${effort} before sending a task prompt`, async t => {
    const context = await withEffortFixture(t, mode);
    const started = await submit(context, 'fixture:normal', { allowed_paths, reasoning_effort: effort });
    const finished = await waitTask(context, started.task_id);
    assert.equal(finished.status, 'failed');
    assert.match(finished.error, pattern);
    assert.equal(finished.result, '');
    await assert.rejects(access(join(context.root, '.fixture-prompt.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(context.root, 'result.txt')), { code: 'ENOENT' });
    // Invalid effort must leave MCP available for subsequent operations.
    assert.equal((await context.client.listTools()).tools.length, 5);
  });
}

test('MCP validates effort shape and normalizes surrounding whitespace before ACP selection', async t => {
  const context = await withEffortFixture(t);
  const tools = await context.client.listTools();
  const input = tools.tools.find(tool => tool.name === 'dsh_submit_task').inputSchema;
  assert.ok(input.properties.reasoning_effort);
  assert.ok(!input.required.includes('reasoning_effort'));
  for (const reasoning_effort of ['', '  ', 'x'.repeat(129), 3, null]) {
    assertError(await call(context.client, 'dsh_submit_task', {
      workspace: context.root, objective: 'fixture:normal', allowed_paths, reasoning_effort,
    }), /validation|Invalid|reasoning_effort/i);
  }
  assert.deepEqual(data(await call(context.client, 'dsh_list_tasks')).tasks, []);
  await assert.rejects(access(join(context.root, '.fixture-runtime.json')), { code: 'ENOENT' });
  const started = await submit(context, 'fixture:normal', { allowed_paths, reasoning_effort: ' low ' });
  const finished = await waitTask(context, started.task_id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.reasoning_effort, 'low');
  assert.deepEqual((await trace(context.root)).effortChanges, ['low']);
});
