import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// App-server uses newline-delimited JSON-RPC, without Content-Length framing.
export class CodexRPC extends EventEmitter {
  constructor({ bin = 'codex', home, cwd, timeout = 30_000, args = [] } = {}) {
    super();
    this.timeout = timeout;
    this.nextID = 0;
    this.pending = new Map();
    this.closed = false;
    this.child = spawn(bin, [...args, 'app-server', '--listen', 'stdio://'], {
      cwd, env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Never log protocol payloads, prompts, credentials, or stderr containing them.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.close(new Error('Invalid Codex JSON-RPC output')); return; }
      if (message.method) {
        this.emit('message', message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex RPC failed'));
      else pending.resolve(message.result);
    });
    this.child.once('error', () => this.close(new Error('Cannot start Codex; check CODEX_BIN')));
    this.child.once('exit', () => this.close(new Error('Codex app-server exited')));
  }

  send(message) {
    if (this.closed) throw new Error('Codex connection closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'artex_codex_bridge', title: 'ARTEX Codex Bridge', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }

  close(error = new Error('Codex connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer); reject(error);
    }
    this.pending.clear();
    this.lines.close();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
    this.emit('closed', error);
  }
}
