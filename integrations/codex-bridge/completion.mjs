import { randomUUID } from 'node:crypto';

export class HTTPError extends Error {
  constructor(status, message, code = status) { super(message); this.status = status; this.code = code; }
}

function codexFailure(error) {
  if (error?.codexErrorInfo === 'cyberPolicy') {
    return new HTTPError(403,
      'Codex rejected this request under its cybersecurity policy (cyberPolicy). Check the security-research access available to your account.',
      'cyber_policy');
  }
  return new Error('Codex failed to complete this request');
}

export function validateCompletion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HTTPError(400, 'Expected a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new HTTPError(400, 'model is required; use GET /v1/models');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HTTPError(400, 'messages must be a nonempty array');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HTTPError(400, 'stream must be boolean');
  if (body.n !== undefined && body.n !== 1) throw new HTTPError(400, 'Only n=1 is supported');
  for (const key of ['stop', 'logprobs', 'top_logprobs', 'seed', 'audio', 'modalities']) {
    if (body[key] != null) throw new HTTPError(400, `${key} is not supported by the Codex bridge`);
  }
  for (const message of body.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new HTTPError(400, 'Invalid message role');
    if (message.content != null && typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || message.content.some(p => !p || p.type !== 'text' || typeof p.text !== 'string')) {
        throw new HTTPError(400, 'Only text content is supported');
      }
    }
    if (message.role !== 'assistant' && message.content == null) throw new HTTPError(400, 'Message content is required');
  }
  if (body.tools != null && !Array.isArray(body.tools)) throw new HTTPError(400, 'tools must be an array');
  const names = new Set();
  for (const tool of body.tools || []) {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || typeof fn.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name) || names.has(fn.name)) {
      throw new HTTPError(400, 'Expected unique function tools with valid names');
    }
    if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) throw new HTTPError(400, 'Function parameters must be a JSON schema');
    names.add(fn.name);
  }
  if (body.tool_choice != null && !['auto', 'none'].includes(body.tool_choice)) throw new HTTPError(400, 'tool_choice supports auto or none');
  if (body.response_format != null && !['text', 'json_schema'].includes(body.response_format.type)) throw new HTTPError(400, 'response_format supports text or json_schema');
  if (body.response_format?.type === 'json_schema' && !body.response_format.json_schema?.schema) throw new HTTPError(400, 'response_format.json_schema.schema is required');
}

const text = content => typeof content === 'string' ? content : (content || []).map(p => p.text).join('\n');

// ARTEX owns execution. Codex is only allowed to propose supplied functions.
// A new ephemeral thread for each request avoids shared context between workers.
export async function complete(rpc, body, { cwd, signal, timeout = 300_000, onDelta = () => {} } = {}) {
  validateCompletion(body);
  const tools = body.tool_choice === 'none' ? [] : (body.tools || []);
  const toolNames = new Map(tools.map((tool, i) => [`artex_tool_${i}`, tool.function.name]));
  const instructions = body.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => text(m.content));
  const transcript = body.messages.filter(m => !['system', 'developer'].includes(m.role));
  let threadId;
  let answer = '';
  let usage;
  let lastFailure;
  let settle;
  let rejectResult;
  const result = new Promise((resolve, reject) => { settle = resolve; rejectResult = reject; });
  // Install listeners before turn/start; notifications can precede its response.
  const onMessage = message => {
    const p = message.params || {};
    if (!threadId || p.threadId !== threadId) return;
    if (message.id != null && message.method === 'item/tool/call') {
      const name = toolNames.get(p.tool);
      if (!name) { rejectResult(new HTTPError(502, 'Codex requested an unknown ARTEX function')); return; }
      // Do not execute or acknowledge the call. Returning it to ARTEX ends this
      // inference; the owning HTTP handler closes the isolated app-server.
      settle({ content: answer || null, tool_calls: [{
        id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
        function: { name, arguments: JSON.stringify(p.arguments ?? {}) },
      }], finish_reason: 'tool_calls', usage });
    } else if (message.id != null) {
      // Never grant built-in command, filesystem, connector or approval requests.
      try { rpc.send({ id: message.id, error: { code: -32601, message: 'Only ARTEX function calls are supported' } }); } catch {}
      rejectResult(new HTTPError(502, `Codex requested an unsupported built-in tool (${message.method})`));
    } else if (message.method === 'item/agentMessage/delta') {
      answer += p.delta;
      onDelta(p.delta);
    } else if (message.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage?.total;
      if (u) usage = { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens,
        prompt_tokens_details: { cached_tokens: u.cachedInputTokens || 0 } };
    } else if (message.method === 'error') {
      lastFailure = p.error;
    } else if (message.method === 'turn/completed') {
      if (p.turn.status !== 'completed') rejectResult(codexFailure(p.turn.error?.codexErrorInfo ? p.turn.error : lastFailure || p.turn.error));
      else if (!answer) rejectResult(new HTTPError(502, 'Codex returned no text or ARTEX function call'));
      else settle({ content: answer, finish_reason: 'stop', usage });
    }
  };
  const onClose = error => rejectResult(error);
  const onAbort = () => rejectResult(new HTTPError(499, 'Request cancelled'));
  const timer = setTimeout(() => rejectResult(new HTTPError(504, 'Codex completion timed out')), timeout);
  rpc.on('message', onMessage);
  rpc.on('closed', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });
  // Observe early rejection while the sequential RPC setup is still pending.
  result.catch(() => {});
  try {
    if (signal?.aborted) throw new HTTPError(499, 'Request cancelled');
    const run = async () => {
      const started = await rpc.request('thread/start', {
        model: body.model, modelProvider: 'openai', cwd,
        ephemeral: true, environments: [], approvalPolicy: 'untrusted', sandbox: 'read-only',
        baseInstructions: [
          'You provide the next assistant reply for an ARTEX conversation.',
          'The next user message contains a JSON conversation transcript. Preserve its message roles and tool results when deciding the next reply.',
          'Only propose the supplied ARTEX functions. Do not run built-in tools, browse, inspect local files, or execute commands.',
          ...instructions,
        ].join('\n\n'),
        developerInstructions: 'Return only the next assistant reply or an ARTEX function call. ARTEX executes functions externally.',
        dynamicTools: tools.map((tool, i) => ({ type: 'function', name: `artex_tool_${i}`,
          description: `${tool.function.name}: ${tool.function.description || ''}`,
          inputSchema: tool.function.parameters, deferLoading: false })),
        config: { web_search: 'disabled', 'features.shell_tool': false, 'features.apply_patch_freeform': false },
      });
      threadId = started.thread.id;
      await rpc.request('turn/start', {
        threadId, input: [{ type: 'text', text: JSON.stringify({ messages: transcript }), text_elements: [] }],
        ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}),
        ...(body.response_format?.type === 'json_schema' ? { outputSchema: body.response_format.json_schema.schema } : {}),
      });
      return result;
    };
    return await Promise.race([run(), result]);
  } finally {
    clearTimeout(timer);
    rpc.off('message', onMessage);
    rpc.off('closed', onClose);
    signal?.removeEventListener('abort', onAbort);
  }
}
