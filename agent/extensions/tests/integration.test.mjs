import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('offline Pi loads all extensions, runs protected tools, reloads and resets session grants', { timeout: 45000 }, async t => {
  const repo = process.cwd();
  const workspace = await mkdtemp(join(tmpdir(), 'pi-rpc-test-'));
  const search = await mkdtemp(join(repo, 'agent/extensions/tests/rpc-search-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.stdin.end(); child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      });
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(search, { recursive: true, force: true });
  });
  await writeFile(join(search, 'normal.ts'), 'ordinary fixture\n');
  await writeFile(join(search, '.env'), 'private fixture synthetic-value\n');
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_')) delete gitEnv[key];
  assert.equal(spawnSync('git', ['init', '--quiet', workspace], { env: gitEnv }).status, 0);
  await writeFile(join(workspace, 'tracked.txt'), 'heading\n' + 'removable content\n'.repeat(50) + 'keep\n');
  assert.equal(spawnSync('git', ['-C', workspace, 'add', '--', 'tracked.txt'], { env: gitEnv }).status, 0);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'exit 7' } }));
  const agent = join(workspace, 'agent'); await mkdir(agent);
  const extensions = [];
  for (const entry of await readdir(join(repo, 'agent/extensions'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) extensions.push(join(repo, 'agent/extensions', entry.name));
    if (entry.isDirectory()) {
      const children = await readdir(join(repo, 'agent/extensions', entry.name));
      if (children.includes('index.ts')) extensions.push(join(repo, 'agent/extensions', entry.name, 'index.ts'));
    }
  }
  const args = ['--offline', '--mode', 'rpc', '--provider', 'harness-test', '--model', 'test',
    ...extensions.flatMap(path => ['-e', path]), '-e', join(repo, 'agent/extensions/tests/rpc-fixture.ts'),
    '--skill', join(repo, 'agent/skills/write-plan/SKILL.md')];
  child = spawn('pi', args, { cwd: workspace, env: {
    ...process.env, PI_CODING_AGENT_DIR: agent, SUPERSET_TERMINAL_ID: '',
    PI_HARNESS_FILE: join(search, 'normal.ts'), PI_HARNESS_SEARCH: search,
    PI_HARNESS_REQUESTS: join(workspace, 'requests.jsonl'),
    PI_HARNESS_WRITE: join(workspace, 'written.txt'),
    PI_HARNESS_TRACKED_EDIT: join(workspace, 'tracked.txt'),
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', seq = 0;
  const events = [], pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', code => { for (const { reject } of pending.values()) reject(new Error(`Pi exited ${code}: ${stderr}`)); pending.clear(); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      events.push(event);
      if (event.type === 'response' && pending.has(event.id)) { pending.get(event.id).resolve(event); pending.delete(event.id); }
    }
  });
  function request(type, extra = {}) {
    const id = String(++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${type}: ${stderr}`)); }, 15000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: err => { clearTimeout(timer); reject(err); } });
      child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n');
    });
  }
  async function prompt(message) { const result = await request('prompt', { message }); assert.equal(result.success, true, JSON.stringify(result)); }
  async function status() {
    await prompt('/harness-status');
    const item = events.filter(e => e.type === 'extension_ui_request' && e.method === 'notify').at(-1);
    return JSON.parse(item.message);
  }
  const initial = await request('get_state'); assert.equal(initial.success, true, JSON.stringify(initial));
  assert.equal((await status()).allowed, false);
  assert.ok(!(await status()).tools.includes('ask_user_question'));
  await prompt('/harness-grant'); assert.equal((await status()).allowed, true);
  await prompt('/harness-reload'); assert.equal((await status()).allowed, false);
  await prompt('/harness-grant'); await request('new_session'); assert.equal((await status()).allowed, false);
  for (const message of ['read fixture', 'search fixture', 'bash fixture', 'bash failure fixture', 'write fixture', 'rewrite fixture', 'edit fixture', 'tracked edit fixture', 'tracked removal fixture', 'advisor fixture', '/plan synthetic planning task']) {
    const before = events.length;
    await prompt(message);
    const deadline = Date.now() + 10000;
    while (!events.slice(before).some(e => e.type === 'agent_end') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.slice(before).some(e => e.type === 'agent_end'), `No completion: ${JSON.stringify(events.slice(before))}`);
  }
  assert.ok((await readFile(join(workspace, 'written.txt'), 'utf8')).startsWith('third\n'));
  assert.equal(await readFile(join(workspace, 'tracked.txt'), 'utf8'), 'updated heading\nkeep\n');
  assert.deepEqual(events.filter(e => e.type === 'extension_ui_request' && e.method === 'select'), [], 'Ordinary tool runs must not request permission');
  const requests = await readFile(join(workspace, 'requests.jsonl'), 'utf8');
  assert.ok(requests.includes('Plan-First Workflow') && requests.includes('synthetic planning task'), requests);
  const messages = await request('get_messages');
  const serialized = JSON.stringify(messages);
  assert.ok(serialized.includes('ordinary fixture'), serialized);
  assert.ok(serialized.includes('package.json'), serialized);
  assert.ok(serialized.includes('Command exited with code 7'), serialized);
  assert.ok(serialized.includes('Offline advisor retry succeeded'), serialized);
  const advice = messages.data.messages.find(message => message.role === 'toolResult' && message.toolName === 'advisor');
  assert.equal(advice.details.requestAttempts, 2);
  assert.equal(advice.usage.input, 20); assert.equal(advice.usage.output, 4);
  assert.ok(JSON.stringify(events).includes('Advisor retry 1/2 in 2s'));
  assert.ok(!serialized.includes('private fixture') && !serialized.includes('synthetic-value'), serialized);
  const parentFile = (await status()).sessionFile;
  assert.equal(typeof parentFile, 'string');
  await prompt('/harness-grant'); await prompt('/harness-fork');
  assert.equal((await status()).allowed, false);
  await prompt('/harness-grant'); await prompt(`/harness-switch ${parentFile}`);
  assert.equal((await status()).allowed, false);
  assert.deepEqual(events.filter(e => e.type === 'extension_error'), [], stderr);
  assert.ok(!/Failed to load extension|SyntaxError|TypeError/.test(stderr), stderr);
});
