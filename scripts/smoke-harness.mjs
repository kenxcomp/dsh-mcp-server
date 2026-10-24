// Optional integration: real official Harness, local deterministic model server.
// Never uses a real API credential or contacts a paid model endpoint.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

const marker = 'REAL_HARNESS_FILE_TOOL_OK';
const root = await mkdtemp(join(tmpdir(), 'dsh-harness-smoke-'));
const outside = await mkdtemp(join(tmpdir(), 'dsh-harness-outside-'));
const runtimeRoot = await mkdtemp(join(process.cwd(), '.dsh-test-runtime-'));
const operations = [
  { name: 'write', input: { file_path: join(root, 'result.txt'), content: `${marker}\n` } },
  { name: 'bash', input: { command: 'cat result.txt', description: 'Verify the local smoke result', timeoutMs: 5000 } },
  { name: 'write', input: { file_path: join(outside, 'denied.txt'), content: 'must not be written' } },
  { name: 'write', input: { file_path: join(outside, 'escalated.txt'), content: 'must not be written',
    sandbox_permissions: 'danger-full-access', justification: 'Smoke test attempts a forbidden scope expansion' } },
];
const requests = [];
let server;
let tasks;
let client;
const http = createHttpServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/messages');
      assert.equal(parsed.model, 'deepseek-v4-flash');
      const operation = operations[requests.length - 1];
      const toolTurn = operation !== undefined;
      assert.ok(requests.length <= operations.length + 1, 'Unexpected extra model turn');
      if (toolTurn) assert.ok(parsed.tools.some(tool => tool.name === operation.name), `Harness must advertise ${operation.name}`);
      if (requests.length > 1) assert.match(JSON.stringify(parsed.messages), /tool_result/);
      const events = [
        { type: 'message_start', message: { id: `msg_${requests.length}`, model: parsed.model,
          usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: toolTurn
          ? { type: 'tool_use', id: `smoke_${requests.length}`, name: operation.name, input: {} }
          : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: toolTurn
          ? { type: 'input_json_delta', partial_json: JSON.stringify(operation.input) }
          : { type: 'text_delta', text: marker } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: toolTurn ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch {
      response.writeHead(400).end('Unexpected local smoke-test request');
    }
  });
});

try {
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const config = await loadConfig({
    PATH: process.env.PATH, HOME: root,
    DSH_MCP_COMMAND: process.env.DSH_SMOKE_COMMAND || 'dsh',
    DEEPSEEK_API_KEY: 'local-smoke-fixture-not-a-real-credential',
    DSH_MCP_RUNTIME_ROOT: runtimeRoot,
  });
  // Test-only route injection. The normal CLI never receives this local server
  // URL or any credential from the user's environment during the smoke test.
  config.childEnv.DEEPSEEK_BASE_URL = `http://127.0.0.1:${http.address().port}`;
  ({ server, tasks } = createServer(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'official-harness-smoke', version: '1' });
  await client.connect(clientTransport);
  const submitted = await client.callTool({ name: 'dsh_submit_task', arguments: {
    workspace: root, objective: 'Create result.txt, verify it with cat, and confirm that outside writes and scope escalation are rejected.',
    allowed_paths: ['result.txt'], timeout_seconds: 30,
  } });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted.content));
  const id = submitted.structuredContent.task_id;
  let result;
  do {
    const response = await client.callTool({ name: 'dsh_get_task', arguments: { task_id: id, wait_ms: 10000 } });
    result = response.structuredContent;
    assert.notEqual(result.status, 'awaiting_permission', 'In-scope writes need no escalation; scope-widening requests must be rejected');
  } while (!['completed', 'failed', 'cancelled', 'timed_out'].includes(result.status));
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.result, marker);
  assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), `${marker}\n`);
  assert.equal(result.tool_calls.length, operations.length, JSON.stringify(result.tool_calls));
  assert.deepEqual(result.tool_calls.map(tool => tool.status), ['completed', 'completed', 'failed', 'failed']);
  assert.match(JSON.stringify(result.tool_calls[1]), /REAL_HARNESS_FILE_TOOL_OK/);
  await assert.rejects(access(join(outside, 'denied.txt')), { code: 'ENOENT' });
  await assert.rejects(access(join(outside, 'escalated.txt')), { code: 'ENOENT' });
  assert.equal(requests.length, operations.length + 1);
  console.log(JSON.stringify({ verified: 'official-harness-with-local-model', model: result.model,
    model_requests: requests.length, native_file_write: true, native_shell_check: true,
    outside_write_denied: true, scope_escalation_denied: true, paid_api_calls: 0 }));
} finally {
  await tasks?.close();
  await client?.close();
  await server?.close();
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
}
