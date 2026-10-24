// Isolated ACP peer for task-scope permission decisions; no external service.
import { createInterface } from 'node:readline';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const model = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
const sessionId = 'task-permission-session';
const pending = new Map();
let workspace;
let nextPermission = 1;

function send(frame) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`); }
function respond(id, result) { send({ id, result }); }
function update(value) { send({ method: 'session/update', params: { sessionId, update: value } }); }
function options() {
  return [{ id: 'model', name: 'Model', type: 'select', currentValue: model,
    options: [{ value: model, name: 'Flash' }] }];
}

function tool(toolCallId, rawInput) {
  update({ sessionUpdate: 'tool_call', toolCallId, title: 'Fixture task-scoped operation',
    kind: 'edit', status: 'pending', rawInput });
}

async function ask(toolCallId, allowReject = true, inlineInput) {
  const id = `permission-${nextPermission++}`;
  const answer = new Promise(resolve => pending.set(id, resolve));
  send({ id, method: 'session/request_permission', params: {
    sessionId, toolCall: { toolCallId, ...(inlineInput === undefined ? {} : { rawInput: inlineInput }) }, options: [
      { optionId: 'yes-once', name: 'Allow once', kind: 'allow_once' },
      ...(allowReject ? [{ optionId: 'no-once', name: 'Reject once', kind: 'reject_once' }] : []),
    ],
  } });
  return (await answer).outcome;
}

async function autoCases() {
  const results = {};
  // The escalation field appears after the public tool-record clipping limit.
  tool('large-danger', { command: 'x'.repeat(10_000), sandbox_permissions: 'danger-full-access' });
  results.largeDanger = await ask('large-danger');
  tool('unknown-mode', { sandbox_permissions: 'unrecognized-full-mode' });
  results.unknownMode = await ask('unknown-mode');
  tool('array-input', []);
  results.arrayInput = await ask('array-input');
  tool('string-input', 'unparsed tool arguments');
  results.stringInput = await ask('string-input');
  results.noContext = await ask('missing-tool');
  tool('no-reject-choice', { sandbox_permissions: 'danger-full-access' });
  results.noRejectChoice = await ask('no-reject-choice', false);
  tool('unchanged-danger', { sandbox_permissions: 'danger-full-access' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'unchanged-danger', status: 'in_progress' });
  results.updateWithoutInput = await ask('unchanged-danger');
  tool('changed-danger', { file_path: 'result.txt' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'changed-danger',
    rawInput: { sandbox_permissions: 'danger-full-access' } });
  results.updateWithDanger = await ask('changed-danger');
  tool('inline-cannot-override', { sandbox_permissions: 'danger-full-access' });
  results.inlineCannotOverride = await ask('inline-cannot-override', true, { sandbox_permissions: 'workspace-write' });
  results.inlineDanger = await ask('inline-danger', true, { sandbox_permissions: 'danger-full-access' });
  results.inlineNull = await ask('inline-null', true, null);
  return results;
}

async function normalCases() {
  const results = {};
  tool('normal-write', { file_path: 'approved.txt', content: 'approved fixture' });
  results.normal = await ask('normal-write');
  if (results.normal.outcome === 'selected' && results.normal.optionId === 'yes-once') {
    await writeFile(join(workspace, 'approved.txt'), 'approved fixture');
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'normal-write', status: 'completed' });
  tool('workspace-write', { file_path: 'rejected.txt', sandbox_permissions: 'workspace-write' });
  results.workspaceWrite = await ask('workspace-write');
  if (results.workspaceWrite.outcome === 'selected' && results.workspaceWrite.optionId === 'yes-once') {
    await writeFile(join(workspace, 'rejected.txt'), 'must be rejected');
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'workspace-write', status: 'completed' });
  return results;
}

const lines = createInterface({ input: process.stdin });
lines.once('close', () => process.exit(0));
lines.on('line', async line => {
  try {
    const frame = JSON.parse(line);
    if (!frame.method) {
      pending.get(frame.id)?.(frame.result);
      pending.delete(frame.id);
      return;
    }
    const { id, method, params } = frame;
    if (method === 'initialize') {
      respond(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    } else if (method === 'session/new') {
      workspace = params.cwd;
      const path = join(process.env.DSH_HOME, 'profiles/acp/cordis.patch.yml');
      const patch = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(join(workspace, '.scope-fixture.json'), JSON.stringify({
        patch, patchMode: (await stat(path)).mode & 0o777, spawnCwd: process.cwd(), sessionCwd: params.cwd,
      }));
      respond(id, { sessionId, configOptions: options() });
    } else if (method === 'session/set_config_option') {
      respond(id, { configOptions: options() });
    } else if (method === 'session/prompt') {
      const prompt = params.prompt.map(item => item.text ?? '').join('');
      let result;
      if (prompt.includes('scope:auto-cases')) result = await autoCases();
      else if (prompt.includes('scope:capacity')) {
        for (let index = 0; index < 129; index++) tool(`queued-${index}`, { file_path: 'unused.txt' });
        result = { evictedContext: await ask('queued-0') };
      } else if (prompt.includes('scope:inline')) {
        const inline = await ask('inline-write', true, { file_path: 'inline.txt', sandbox_permissions: 'workspace-write' });
        if (inline.outcome === 'selected' && inline.optionId === 'yes-once') {
          await writeFile(join(workspace, 'inline.txt'), 'approved inline fixture');
        }
        result = { inline };
      } else result = await normalCases();
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } });
      respond(id, { stopReason: 'end_turn' });
    } else if (method === 'session/close') respond(id, {});
  } catch {
    process.stderr.write('task-permission fixture failed\n');
    process.exit(2);
  }
});
