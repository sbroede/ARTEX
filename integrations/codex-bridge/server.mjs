import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRPC } from './rpc.mjs';
import { complete, validateCompletion, HTTPError } from './completion.mjs';
import { WorkerQueue } from './queue.mjs';

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
const authMatches = (value, token) => {
  const a = Buffer.from(value || '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function readJSON(request, limit) {
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw new HTTPError(413, 'Request body too large');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new HTTPError(400, 'Invalid JSON'); }
}

export function createBridge({ token, bin = 'codex', home, maxConcurrent = 2,
  maxQueued = 16, queueTimeout = 120_000,
  timeout = 300_000, maxBody = 16 * 1024 * 1024,
  rpcFactory = options => new CodexRPC(options) } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('CODEX_BRIDGE_API_KEY must contain at least 32 characters');
  if (!home) throw new Error('A dedicated CODEX_HOME is required');
  let admitted = 0;
  const queue = new WorkerQueue(maxConcurrent, maxQueued, queueTimeout);
  let control;
  let initializing;
  const workers = new Set();
  const account = async () => {
    if (control?.closed) { control = undefined; initializing = undefined; }
    if (!control) {
      control = rpcFactory({ bin, home, cwd: home });
      initializing = control.initialize();
      initializing.catch(() => { control?.close(); });
    }
    await initializing;
    return control;
  };

  const server = createServer(async (request, response) => {
    let rpc;
    let cwd;
    let admittedRequest = false;
    let release;
    let keepalive;
    const abort = new AbortController();
    response.once('close', () => { if (!response.writableEnded) { abort.abort(); rpc?.close(); } });
    try {
      // Reject browser-origin traffic; this is a server-to-server local bridge.
      if (request.headers.origin) throw new HTTPError(403, 'Browser-origin requests are not accepted');
      if (!authMatches(request.headers.authorization, token)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new HTTPError(401, 'Invalid bridge API key');
      }
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/healthz') return json(response, 200, { ok: true });
      if (request.method === 'GET' && path === '/auth/status') {
        const client = await account();
        const result = await client.request('account/read', { refreshToken: false });
        // Return only mode and connection status; do not expose identity or credentials.
        return json(response, 200, { authenticated: !!result.account, mode: result.account?.type || null });
      }
      if (request.method === 'POST' && path === '/auth/login') {
        const client = await account();
        const login = await client.request('account/login/start', { type: 'chatgpt' });
        return json(response, 200, { login_id: login.loginId, auth_url: login.authUrl });
      }
      if (request.method === 'POST' && path === '/auth/cancel') {
        const body = await readJSON(request, 4096);
        if (typeof body.login_id !== 'string') throw new HTTPError(400, 'login_id is required');
        const client = await account();
        await client.request('account/login/cancel', { loginId: body.login_id });
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && path === '/v1/models') {
        const client = await account();
        const models = [];
        let cursor;
        do {
          const page = await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
          models.push(...page.data.map(m => ({ id: m.model, object: 'model', created: 0, owned_by: 'openai' })));
          cursor = page.nextCursor;
        } while (cursor);
        return json(response, 200, { object: 'list', data: models });
      }
      if (request.method !== 'POST' || path !== '/v1/chat/completions') throw new HTTPError(404, 'Endpoint not found');
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HTTPError(415, 'Use Content-Type: application/json');
      // Bound body readers as well as queued requests. Read before queuing so a
      // waiting upload cannot hit Node's request-body timeout under backpressure.
      if (admitted >= maxConcurrent + maxQueued) throw new HTTPError(429, 'Codex bridge queue is full; retry later');
      admitted++; admittedRequest = true;
      const body = await readJSON(request, maxBody);
      validateCompletion(body);
      release = await queue.acquire(abort.signal);
      if (abort.signal.aborted) throw new HTTPError(499, 'Request cancelled');
      cwd = await mkdtemp(join(tmpdir(), 'artex-codex-'));
      rpc = rpcFactory({ bin, home, cwd });
      workers.add(rpc);
      await rpc.initialize();
      if (abort.signal.aborted) throw new HTTPError(499, 'Request cancelled');
      const identity = await rpc.request('account/read', { refreshToken: false });
      if (identity.account?.type !== 'chatgpt') throw new HTTPError(401, 'Sign in with ChatGPT using node cli.mjs login');
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const base = { id, created, model: body.model };
      const ignored = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'max_completion_tokens']
        .filter(key => body[key] != null);
      if (ignored.length) response.setHeader('X-Codex-Bridge-Ignored-Parameters', ignored.join(', '));
      const chunk = (delta, finish_reason = null, usage) => {
        if (!response.destroyed) response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      };
      const startStream = () => {
        if (response.headersSent) return;
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        chunk({ role: 'assistant', content: '' });
        keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15_000);
      };
      const output = await complete(rpc, body, { cwd, signal: abort.signal, timeout,
        onDelta: delta => { if (body.stream && delta) { startStream(); chunk({ content: delta }); } },
      });
      if (body.stream) {
        // Do not send HTTP 200 until actual content or a successful tool result.
        // ARTEX's OpenAI reader can otherwise treat a later SSE error as success.
        startStream();
        if (output.tool_calls) chunk({ tool_calls: output.tool_calls.map((call, index) => ({ index, ...call })) });
        // Norma stops reading at finish_reason, so usage must accompany that
        // chunk rather than arriving later in a choices:[] chunk.
        chunk({}, output.finish_reason, body.stream_options?.include_usage ? output.usage : undefined);
        response.end('data: [DONE]\n\n');
      } else {
        json(response, 200, { ...base, object: 'chat.completion', choices: [{ index: 0,
          message: { role: 'assistant', content: output.content, ...(output.tool_calls ? { tool_calls: output.tool_calls } : {}) },
          finish_reason: output.finish_reason }], ...(output.usage ? { usage: output.usage } : {}) });
      }
    } catch (error) {
      if (!response.destroyed) {
        const status = error.status || 502;
        // RPC errors can echo request contents. Keep upstream failures generic.
        const message = error.status ? error.message : 'Codex failed to complete this request';
        const payload = { error: { message, type: status === 403 ? 'permission_error' : status < 500 ? 'invalid_request_error' : 'api_error', code: error.code || status } };
        if (!response.headersSent && (status === 429 || status === 503)) response.setHeader('Retry-After', '5');
        if (response.headersSent) {
          // No clean DONE after a failed partial response. Readers that ignore
          // SSE error objects must still observe a transport failure.
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
          response.destroy();
        } else json(response, status, payload);
      }
    } finally {
      clearInterval(keepalive);
      release?.();
      if (admittedRequest) admitted--;
      if (rpc) { workers.delete(rpc); rpc.close(); }
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });
  server.requestTimeout = 30_000;
  server.on('close', () => { control?.close(); for (const rpc of workers) rpc.close(); });
  return server;
}
