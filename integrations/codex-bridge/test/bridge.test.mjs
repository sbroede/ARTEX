import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { CodexRPC } from '../rpc.mjs';
import { createBridge } from '../server.mjs';
import { validateCompletion } from '../completion.mjs';

const token = 'test-key-'.repeat(8);
const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const body = (model = 'mock-text', extra = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });
const tool = { type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } };

async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'artex-bridge-test-'));
  const clients = [];
  const server = createBridge({ token, home, timeout: 500, ...options,
    rpcFactory: config => { const rpc = new CodexRPC({ ...config, bin: process.execPath, args: [fixture, ...(options.fixtureArgs || [])], timeout: 1000 }); clients.push(rpc); return rpc; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.all(clients.map(rpc => rpc.child.exitCode !== null || rpc.child.signalCode !== null ? undefined : once(rpc.child, 'exit')));
    await rm(home, { recursive: true, force: true });
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  return { clients, root, request: (path, value, headers = {}) => fetch(root + path, {
    method: value === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
  }) };
}

test('protects all routes and rejects browser origins', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/v1/models', undefined, { Authorization: '' })).status, 401);
  assert.equal((await request('/auth/login', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/healthz')).status, 200);
});

test('managed auth status omits identity; login and cancel use Codex', async t => {
  const { request } = await setup(t);
  assert.deepEqual(await (await request('/auth/status')).json(), { authenticated: true, mode: 'chatgpt' });
  assert.deepEqual(await (await request('/auth/login', {})).json(), { login_id: 'login-1', auth_url: 'https://auth.openai.com/mock' });
  assert.equal((await request('/auth/cancel', { login_id: 'login-1' })).status, 200);
});

test('paginates live Codex models', async t => {
  const { request } = await setup(t);
  const result = await (await request('/v1/models')).json();
  assert.deepEqual(result.data.map(m => m.id), ['mock-text', 'mock-tool']);
});

for (const flag of ['--signed-out', '--api-key']) test(`requires ChatGPT login before inference (${flag})`, async t => {
  const { request } = await setup(t, { fixtureArgs: [flag] });
  const response = await request('/v1/chat/completions', body());
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /Sign in with ChatGPT/);
});

test('nonstreaming completion reports text and actual token usage', async t => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', body('mock-text', { max_tokens: 100 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-codex-bridge-ignored-parameters'), 'max_tokens');
  const result = await response.json();
  assert.equal(result.choices[0].message.content, 'Hello ARTEX');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 12);
});

test('streaming emits deltas, finish, separate usage, and DONE', async t => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', body('mock-text', { stream: true, stream_options: { include_usage: true } }));
  const stream = await response.text();
  const data = stream.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
  assert.equal(data.pop(), '[DONE]');
  const chunks = data.map(JSON.parse);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.slice(1, 3).map(c => c.choices[0].delta.content).join(''), 'Hello ARTEX');
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(chunks.at(-1).usage.total_tokens, 12);
});

for (const stream of [false, true]) test(`returns external tool calls without executing (${stream ? 'SSE' : 'JSON'})`, async t => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', body('mock-tool', { tools: [tool], stream }));
  assert.equal(response.status, 200);
  if (stream) {
    const output = await response.text();
    assert.match(output, /"finish_reason":"tool_calls"/);
    assert.match(output, /"name":"search"/);
  } else {
    const output = await response.json();
    const call = output.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'search');
    assert.deepEqual(JSON.parse(call.function.arguments), { query: 'example' });
    assert.equal(output.choices[0].finish_reason, 'tool_calls');
  }
});

test('rejects malformed and unsupported input before starting Codex', async t => {
  const { request, clients } = await setup(t, { maxBody: 1024 });
  for (const value of ['{', body('mock-text', { messages: [] }), body('mock-text', { tool_choice: 'required' }), body('mock-text', { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })]) {
    assert.equal((await request('/v1/chat/completions', value)).status, 400);
  }
  assert.equal((await request('/v1/chat/completions', body('mock-text', { messages: [{ role: 'user', content: 'x'.repeat(2048) }] }))).status, 413);
  assert.equal(clients.length, 0);
});

for (const model of ['mock-error', 'mock-setup-error', 'mock-builtin', 'mock-exit']) test(`handles ${model} without leaking upstream payloads`, async t => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', body(model));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private/);
});

test('timeout releases worker capacity', async t => {
  const { request } = await setup(t, { timeout: 100, maxConcurrent: 1 });
  assert.equal((await request('/v1/chat/completions', body('mock-slow'))).status, 504);
  assert.equal((await request('/v1/chat/completions', body())).status, 200);
});

test('concurrency rejects overload and a disconnect terminates Codex', async t => {
  const { request, root, clients } = await setup(t, { timeout: 5000, maxConcurrent: 1 });
  const abort = new AbortController();
  const pending = fetch(root + '/v1/chat/completions', { method: 'POST', signal: abort.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body('mock-slow', { stream: true })),
  });
  const first = await pending;
  assert.equal((await request('/v1/chat/completions', body())).status, 429);
  abort.abort();
  await first.body.cancel().catch(() => {});
  if (!clients[0].closed) await once(clients[0], 'closed');
  assert.equal(clients[0].closed, true);
});

test('validates credentials and tool names', () => {
  assert.throws(() => createBridge({ token: 'short', home: '/tmp' }), /32/);
  assert.throws(() => validateCompletion(body('mock-text', { tools: [tool, tool] })), /unique/);
  assert.throws(() => validateCompletion(body('mock-text', { tools: [{ type: 'function', function: { parameters: {} } }] })), /unique/);
});
