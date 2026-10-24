import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from './helpers.mjs';

test('a completed worker releases inherited stdio even when an independent background process keeps it open',
  { skip: process.platform === 'win32', timeout: 12_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-worker-pipes-'));
    const fixture = join(root, 'agent.mjs');
    const wrapper = join(root, 'worker.mjs');
    const statePath = join(root, 'runtime.json');
    const orphanPath = join(root, 'background.pid');
    let child;
    let timer;
    t.after(async () => {
      clearTimeout(timer);
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      // Only the PID created by this fixture is signalled; it deliberately has
      // its own process group, so the worker cannot manage it via its root PGID.
      try {
        const pid = Number(await readFile(orphanPath, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(-pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(fixture, `
      import { createInterface } from 'node:readline';
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const model = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
      const configOptions = [{ id: 'model', name: 'Model', type: 'select', currentValue: model,
        options: [{ value: model, name: 'Flash' }] }];
      const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const { id, method } = JSON.parse(line);
        if (method === 'initialize') send(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        if (method === 'session/new') {
          writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ pid: process.pid, home: process.env.DSH_HOME }));
          send(id, { sessionId: 'pipe-fixture', configOptions });
        }
        if (method === 'session/set_config_option') send(id, { configOptions });
        if (method === 'session/prompt') {
          const background = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
            detached: true, stdio: ['ignore', process.stdout, process.stderr],
          });
          writeFileSync(${JSON.stringify(orphanPath)}, String(background.pid));
          background.unref();
          send(id, { stopReason: 'end_turn' });
          setTimeout(() => process.exit(0), 20);
        }
      });
    `);
    const workerUrl = pathToFileURL(join(repo, 'dist/acp-worker.js')).href;
    await writeFile(wrapper, `
      import { AcpWorker } from ${JSON.stringify(workerUrl)};
      const worker = new AcpWorker({
        command: process.execPath, args: [${JSON.stringify(fixture)}],
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        childEnv: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture-only-not-real' },
      }, { ready() {}, update() {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) });
      const reason = await worker.run({ workspace: ${JSON.stringify(root)}, objective: 'Fixture only', allowed_paths: ['.'] });
      console.log(JSON.stringify({ reason }));
    `);
    child = spawn(process.execPath, [wrapper], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const result = await Promise.race([
      closed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Worker wrapper stayed alive after completion: ${stdout} ${stderr}`)), 8000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, stderr);
    assert.equal(JSON.parse(stdout).reason, 'end_turn');
    const runtime = JSON.parse(await readFile(statePath, 'utf8'));
    assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(runtime.home), { code: 'ENOENT' });
    const background = Number(await readFile(orphanPath, 'utf8'));
    assert.doesNotThrow(() => process.kill(background, 0), 'Independent fixture should still hold inherited pipes');
  });
