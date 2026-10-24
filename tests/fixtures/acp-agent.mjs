// Independent ACP wire fixture: no live provider, credentials or host files.
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const flash = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
const pro = JSON.stringify(['deepseek-official', 'deepseek-v4-pro']);
const sessionId = 'fixture-session';
const permissions = new Map();
let workspace;
let selected = pro;
let cancelPrompt;

function send(message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
function response(id, result) { send({ id, result }); }
function update(value) { send({ method: 'session/update', params: { sessionId, update: value } }); }
function message(text) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); }
function configOptions() {
  return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selected,
    options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
      { value: pro, name: 'DeepSeek Pro' }, { value: flash, name: 'DeepSeek Flash' },
    ] }] }];
}

async function pauseStream() {
  // A subsequent tool update proves the first chunk was already delivered.
  // The test releases the second chunk only after inspecting a live MCP result.
  update({ sessionUpdate: 'tool_call', toolCallId: 'stream-checkpoint', title: 'Fixture stream paused',
    kind: 'read', status: 'in_progress' });
  for (;;) {
    try { await readFile(join(workspace, '.fixture-release')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
}

const lines = createInterface({ input: process.stdin });
lines.once('close', () => process.exit(0));
lines.on('line', async line => {
  try {
    const frame = JSON.parse(line);
    if (!frame.method) {
      permissions.get(frame.id)?.(frame.result);
      permissions.delete(frame.id);
      return;
    }
    const { id, method, params } = frame;
    switch (method) {
      case 'initialize':
        response(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'fixture', version: '1' } });
        break;
      case 'session/new':
        workspace = params.cwd;
        await writeFile(join(workspace, '.fixture-runtime.json'), JSON.stringify({
          pid: process.pid, home: process.env.DSH_HOME, permissionMode: process.env.DSH_PERMISSION_MODE,
          leakedOtherToken: Boolean(process.env.UNRELATED_SECRET_TOKEN),
        }));
        response(id, { sessionId, configOptions: configOptions() });
        break;
      case 'session/set_config_option':
        if (params.configId !== 'model' || params.value !== flash) throw new Error('Expected advertised Flash route');
        selected = params.value;
        response(id, { configOptions: configOptions() });
        break;
      case 'session/prompt': {
        const prompt = params.prompt.map(item => item.text ?? '').join('');
        if (selected !== flash) throw new Error('Prompt sent before Flash selection');
        if (prompt.includes('fixture:crash')) {
          const secret = process.env.DEEPSEEK_API_KEY;
          if (prompt.includes('fixture:crash-secret-split')) {
            process.stderr.write('ordinary diagnostic sentinel: ' + secret.slice(0, -1));
            await delay(50);
            process.stderr.write(secret.slice(-1) + ' trailing diagnostic\n');
          } else if (prompt.includes('fixture:crash-secret-window')) {
            const suffix = ' diagnostic sentinel';
            // Clipping to 4096 before redaction would retain only a key suffix.
            process.stderr.write('ordinary diagnostic: ' + secret
              + 'x'.repeat(4096 - Math.floor(secret.length / 2) - suffix.length) + suffix);
          } else if (prompt.includes('fixture:crash-secret-prefix')) {
            process.stderr.write('ordinary diagnostic sentinel: ' + secret.slice(0, -1));
          } else {
            process.stderr.write(`fixture crash diagnostic ${secret}\n`);
          }
          process.exit(17);
        }
        if (prompt.includes('fixture:hang')) {
          await new Promise(resolve => { cancelPrompt = resolve; });
          response(id, { stopReason: 'cancelled' });
          break;
        }
        if (prompt.includes('fixture:permission')) {
          update({ sessionUpdate: 'tool_call', toolCallId: 'fixture-tool', title: 'Write fixture output',
            kind: 'edit', status: 'pending', rawInput: { path: 'result.txt' } });
          const permission = new Promise(resolve => permissions.set('permission-1', resolve));
          send({ id: 'permission-1', method: 'session/request_permission', params: {
            sessionId, toolCall: { toolCallId: 'fixture-tool' }, options: [
              { optionId: 'yes-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'no-once', name: 'Reject once', kind: 'reject_once' },
            ],
          } });
          const answer = await permission;
          message(`permission:${answer.outcome.optionId ?? answer.outcome.outcome}`);
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-tool', status: 'completed' });
        } else if (prompt.includes('fixture:secret')) {
          const secret = process.env.DEEPSEEK_API_KEY;
          if (prompt.includes('fixture:secret-split') || prompt.includes('fixture:secret-boundary')) {
            const prefix = prompt.includes('fixture:secret-boundary') ? 'x'.repeat(63_990) : 'ordinary prefix: ';
            message(prefix + secret.slice(0, -1));
            await pauseStream();
            message(secret.slice(-1) + ' safe suffix');
          } else if (prompt.includes('fixture:secret-interrupted')) {
            message('ordinary prefix: ' + secret.slice(0, -1));
          } else {
            message(secret.slice(0, 10));
            message(secret.slice(10));
          }
          update({ sessionUpdate: 'tool_call', toolCallId: 'secret-tool', title: `secret ${secret}`,
            kind: 'read', status: 'completed', rawInput: { secret } });
        } else if (prompt.includes('fixture:large')) {
          message('x'.repeat(70_000));
        } else {
          await writeFile(join(workspace, 'result.txt'), 'fixture verified\n');
          message(`selected:${selected}\nfixture verified\n`);
          message(prompt.includes('acceptance sentinel') ? 'acceptance instructions received' : 'no acceptance sentinel');
        }
        response(id, { stopReason: 'end_turn' });
        break;
      }
      case 'session/cancel':
        cancelPrompt?.();
        break;
      case 'session/close':
        response(id, {});
        break;
      default:
        if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown fixture method' } });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
});
