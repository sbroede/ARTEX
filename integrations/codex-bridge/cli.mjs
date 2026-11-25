import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBridge } from './server.mjs';

const command = process.argv[2] || 'serve';
const home = resolve(process.env.CODEX_BRIDGE_HOME || join(homedir(), '.artex', 'codex'));
const bin = process.env.CODEX_BIN || 'codex';
await mkdir(home, { recursive: true, mode: 0o700 });
if (command === 'login' || command === 'status') {
  const child = spawn(bin, ['login', ...(command === 'status' ? ['status'] : process.argv.slice(3))], {
    env: { ...process.env, CODEX_HOME: home }, cwd: home, stdio: 'inherit',
  });
  child.once('error', () => { console.error('Cannot start Codex; set CODEX_BIN to its executable path'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else if (command === 'serve') {
  const host = process.env.CODEX_BRIDGE_HOST || '127.0.0.1';
  const port = Number(process.env.CODEX_BRIDGE_PORT || 8789);
  const maxConcurrent = Number(process.env.CODEX_BRIDGE_CONCURRENCY || 2);
  const maxQueued = Number(process.env.CODEX_BRIDGE_QUEUE_SIZE || 16);
  const queueTimeout = Number(process.env.CODEX_BRIDGE_QUEUE_TIMEOUT_MS || 120_000);
  const timeout = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS || 300_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(maxQueued) || maxQueued < 0 || !Number.isSafeInteger(queueTimeout) || queueTimeout < 1 || !Number.isSafeInteger(timeout) || timeout < 1000) {
    throw new Error('Invalid bridge port, concurrency, or timeout');
  }
  let token = process.env.CODEX_BRIDGE_API_KEY;
  const tokenFile = join(home, 'bridge-api-key');
  if (!token) {
    try { token = (await readFile(tokenFile, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('hex');
      try { await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' }); }
      catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        token = (await readFile(tokenFile, 'utf8')).trim();
      }
    }
    console.error(`Bridge API key file: ${tokenFile}`);
  }
  const server = createBridge({ token, bin, home, maxConcurrent, maxQueued, queueTimeout, timeout });
  server.on('error', error => { console.error(`Cannot listen: ${error.code || 'unknown error'}`); process.exitCode = 1; });
  server.listen(port, host, () => console.error(`ARTEX Codex Bridge: http://${host}:${port}/v1`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
} else {
  console.error('Usage: node cli.mjs serve | login [--device-auth] | status');
  process.exitCode = 1;
}
