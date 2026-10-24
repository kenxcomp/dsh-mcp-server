import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { client, methods, ndJsonStream, PROTOCOL_VERSION,
  type ClientConnection, type SessionConfigOption } from '@agentclientprotocol/sdk';
import type { Config } from './config.js';
import { SecretStream } from './redaction.js';
import type { TaskInput, Worker, WorkerHooks } from './types.js';

function choices(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== 'select') return [];
  return option.options.flatMap(item => 'group' in item ? item.options : [item]);
}

/** Use the advertised opaque value, never invent a model selector or fall back. */
export function selectModel(options: SessionConfigOption[], provider: string, model: string): string {
  const option = options.find(item => item.id === 'model');
  const match = option && choices(option).find(item => {
    try {
      const route: unknown = JSON.parse(item.value);
      return Array.isArray(route) && route.length === 2 && route[0] === provider && route[1] === model;
    } catch { return false; }
  });
  if (!match) throw new Error(`Harness did not advertise ${provider}/${model}. Check credentials, model availability and ACP version.`);
  return match.value;
}

export function taskPrompt(input: TaskInput): string {
  return [
    'Execute this scoped task for a supervising agent. Follow the workspace instructions.',
    'Preserve existing changes. Do not commit, push, publish, change credentials, or broaden scope unless explicitly authorized in the task.',
    'Allowed paths and checks below are task instructions. Stop and report if the requested work requires other paths or permissions.',
    `Objective:\n${input.objective}`,
    `Allowed paths (relative to workspace):\n${input.allowed_paths.map(path => `- ${path}`).join('\n')}`,
    `Constraints:\n${(input.constraints ?? []).map(value => `- ${value}`).join('\n') || '- None supplied'}`,
    `Acceptance checks (run only when safe and applicable):\n${(input.acceptance_checks ?? []).map(value => `- ${value}`).join('\n') || '- Report suitable verification'}`,
    'Return: summary, files changed, checks actually run and their outcomes, remaining issues. Distinguish verified results from assumptions.',
  ].join('\n\n');
}

export class AcpWorker implements Worker {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private sessionId?: string;
  private home?: string;
  private exited?: Promise<void>;
  private stopPromise?: Promise<void>;
  private stopping = false;
  private stderr = '';

  constructor(private readonly config: Config, private readonly hooks: WorkerHooks) {}

  async run(input: TaskInput): Promise<string> {
    try {
      if (this.config.provider === 'deepseek-official' && !this.config.childEnv.DEEPSEEK_API_KEY && !this.config.credentialsFile) {
        throw new Error('DEEPSEEK_API_KEY is missing. Supply a protected env file or explicitly set DSH_MCP_CREDENTIALS_FILE to reuse the Harness credential store.');
      }
      this.home = await mkdtemp(join(tmpdir(), 'dsh-mcp-'));
      if (this.config.credentialsFile) {
        const profile = join(this.home, 'profiles', 'acp');
        await mkdir(profile, { recursive: true, mode: 0o700 });
        // JSON is a YAML subset. Only reference the existing store; never parse,
        // copy or export its contents. Harness owns credential resolution and
        // any normal account refresh under its cross-process writer lock.
        await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
          { id: 'credentials', config: { path: this.config.credentialsFile, watch: false } },
          { id: 'acp', config: { provider: this.config.provider, model: this.config.model } },
        ]), { mode: 0o600 });
      }
      if (this.stopping) throw new Error('Task cancelled before startup');
      const child = spawn(this.config.command, this.config.args, {
        cwd: input.workspace,
        env: { ...this.config.childEnv, DSH_HOME: this.home, DSH_PERMISSION_MODE: 'workspace-write' },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.stdin.on('error', () => { /* Connection closure rejects protocol calls. */ });
      this.exited = new Promise(resolve => child.once('close', resolve));
      const diagnostics = new SecretStream(this.config.childEnv);
      const failure = new Promise<never>((_resolve, reject) => {
        child.once('error', () => reject(new Error('Could not start Harness. Check DSH_MCP_COMMAND and executable permissions.')));
        child.once('close', (code, signal) => {
          this.stderr = (this.stderr + diagnostics.end()).slice(-4096);
          reject(new Error(`Harness exited (${code ?? signal ?? 'unknown'}).`));
        });
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => {
        this.stderr = (this.stderr + diagnostics.write(data)).slice(-4096);
      });
      // Node and DOM web-stream declarations differ structurally; both adapters
      // implement the same WHATWG byte-stream contract at runtime.
      const stream = ndJsonStream(Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1]);
      this.connection = client({ name: 'dsh-mcp-server' })
        .onNotification(methods.client.session.update, ({ params }) => {
          if (params.sessionId === this.sessionId) this.hooks.update(params);
        })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
          if (this.stopping || params.sessionId !== this.sessionId) {
            return { outcome: { outcome: 'cancelled' as const } };
          }
          return this.hooks.permission(params);
        })
        .connect(stream);
      const operation = this.execute(input);
      return await Promise.race([operation, failure]);
    } catch (error) {
      // A closed ACP stream can reject before child 'close' drains stderr.
      // Reap first, then attach the bounded diagnostic and actual exit status.
      await this.stop();
      const message = error instanceof Error ? error.message : 'Harness task failed';
      const exit = this.child?.exitCode ?? this.child?.signalCode;
      throw new Error([message, exit === undefined || exit === null ? '' : `Harness exit: ${exit}.`,
        this.stderr ? `Harness diagnostics: ${this.stderr}` : ''].filter(Boolean).join('\n'));
    } finally {
      await this.stop();
      if (this.home) await rm(this.home, { recursive: true, force: true });
    }
  }

  private async execute(input: TaskInput): Promise<string> {
    const connection = this.connection!;
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'dsh-mcp-server', version: '0.1.0' },
      clientCapabilities: {},
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported ACP protocol version');
    if (this.stopping) throw new Error('Task cancelled during initialization');
    const session = await connection.agent.request(methods.agent.session.new, { cwd: input.workspace, mcpServers: [] });
    this.sessionId = session.sessionId;
    if (this.stopping) throw new Error('Task cancelled during session creation');
    const value = selectModel(session.configOptions ?? [], this.config.provider, this.config.model);
    const selected = await connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionId, configId: 'model', value,
    });
    if (selected.configOptions.find(item => item.id === 'model')?.currentValue !== value) {
      throw new Error('Harness did not confirm the requested model');
    }
    if (this.stopping) throw new Error('Task cancelled before prompt');
    this.hooks.ready(session.sessionId, `${this.config.provider}/${this.config.model}`);
    const result = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId, prompt: [{ type: 'text', text: taskPrompt(input) }],
    });
    return result.stopReason;
  }

  stop(): Promise<void> {
    this.stopping = true;
    return this.stopPromise ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      if (this.connection && this.sessionId && !this.connection.signal.aborted) {
        await Promise.race([
          this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {}),
          delay(250),
        ]);
      }
      child.stdin.end();
      // Graceful EOF lets Harness flush and dispose; a bounded escalation reaps
      // the owned process group, including shell grandchildren, before releasing it.
      await Promise.race([this.exited, delay(500)]);
      this.signalGroup('SIGTERM');
      await Promise.race([this.exited, delay(1000)]);
      this.signalGroup('SIGKILL');
      await Promise.race([this.exited, delay(1000)]);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        throw new Error('Harness cleanup failed: worker is still running');
      }
    } finally {
      // Detached descendants can inherit pipes after the owned root exits.
      // Release our descriptors even when their other ends stay open, and also
      // on signal failures, so a disconnected MCP client can finish shutdown.
      this.connection?.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
