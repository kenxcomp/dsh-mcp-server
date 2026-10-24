import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { TaskManager } from '../dist/tasks.js';

async function metadataResponse(t, key, rawInput) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-redaction-review-'));
  const config = await loadConfig({
    DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([root]), DEEPSEEK_API_KEY: key,
  });
  const tasks = new TaskManager(config, hooks => ({
    async run() {
      hooks.ready('redaction-session', 'deepseek-official/deepseek-v4-flash');
      hooks.update({ sessionId: 'redaction-session', update: {
        sessionUpdate: 'tool_call', toolCallId: 'redaction-tool', title: `credential ${key}`,
        kind: 'read', status: 'completed', rawInput,
      } });
      return 'end_turn';
    },
    async stop() {},
  }));
  const { server } = createServer(config, tasks);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'redaction-review-test', version: '1' });
  t.after(async () => {
    await tasks.close();
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const submitted = await client.callTool({ name: 'dsh_submit_task', arguments: {
    workspace: root, objective: 'Inspect fixture metadata only', allowed_paths: ['.'],
  } });
  assert.ok(!submitted.isError, JSON.stringify(submitted));
  return client.callTool({ name: 'dsh_get_task', arguments: {
    task_id: submitted.structuredContent.task_id, wait_ms: 1000,
  } });
}

test('MCP metadata redacts quoted and backslash credentials before JSON escaping', async t => {
  const key = 'fixture-key-"quoted\\secret';
  const response = await metadataResponse(t, key, { nested: [{ secret: key }] });
  assert.ok(!response.isError);
  assert.equal(response.structuredContent.status, 'completed');
  const tool = response.structuredContent.tool_calls[0];
  assert.equal(tool.rawInput.nested[0].secret, '[REDACTED]');
  assert.equal(tool.title, 'credential [REDACTED]');
  const text = JSON.parse(response.content[0].text);
  assert.equal(text.tool_calls[0].rawInput.nested[0].secret, '[REDACTED]');
});

test('MCP metadata object keys containing a credential are redacted as well as values', async t => {
  const key = 'fixture-key-"quoted\\secret';
  const response = await metadataResponse(t, key, { [key]: { secret: key } });
  assert.ok(!response.isError);
  const input = response.structuredContent.tool_calls[0].rawInput;
  assert.equal(Object.hasOwn(input, key), false);
  assert.deepEqual(input, { '[REDACTED]': { secret: '[REDACTED]' } });
  const text = JSON.parse(response.content[0].text);
  assert.deepEqual(text.tool_calls[0].rawInput, input);
});
