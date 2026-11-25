import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let model;
let cancelled = false;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'mock' } });
  if (m.method === 'account/read') send({ id: m.id, result: { account: process.argv.includes('--signed-out') ? null : { type: process.argv.includes('--api-key') ? 'apiKey' : 'chatgpt', email: 'private@example.com' } } });
  if (m.method === 'account/login/start') send({ id: m.id, result: { loginId: 'login-1', authUrl: 'https://auth.openai.com/mock' } });
  if (m.method === 'account/login/cancel') { cancelled = m.params.loginId === 'login-1'; send({ id: m.id, result: { status: cancelled ? 'canceled' : 'notFound' } }); }
  if (m.method === 'model/list') send({ id: m.id, result: { data: [{ model: m.params.cursor ? 'mock-tool' : 'mock-text' }], nextCursor: m.params.cursor ? null : 'page-2' } });
  if (m.method === 'thread/start') {
    model = m.params.model;
    if (model === 'mock-setup-error') { send({ id: m.id, error: { message: 'private prompt must not leak' } }); continue; }
    if (m.params.ephemeral !== true || m.params.environments.length !== 0 || m.params.sandbox !== 'read-only') process.exit(2);
    if (model === 'mock-tool' && m.params.dynamicTools[0].name !== 'artex_tool_0') process.exit(3);
    send({ id: m.id, result: { thread: { id: 'thread-1' } } });
  }
  if (m.method === 'turn/start') {
    const notify = (method, p) => send({ method, params: { threadId: 'thread-1', ...p } });
    // Deliberately notify BEFORE the turn/start response to cover the race.
    if (model === 'mock-tool') send({ id: 'tool-request', method: 'item/tool/call', params: { threadId: 'thread-1', tool: 'artex_tool_0', arguments: { query: 'example' } } });
    else if (model === 'mock-builtin') send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } });
    else if (model !== 'mock-slow' && model !== 'mock-exit') {
      notify('item/agentMessage/delta', { delta: 'Hello ' });
      notify('item/agentMessage/delta', { delta: 'ARTEX' });
      notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3 } } });
      notify('turn/completed', { turn: { status: model === 'mock-error' ? 'failed' : 'completed', error: { message: 'private upstream payload' } } });
    }
    send({ id: m.id, result: { turn: { id: 'turn-1' } } });
    if (model === 'mock-exit') process.exit(1);
  }
}
