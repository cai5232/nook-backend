import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const port = Number(process.env.PORT) || 3000;
const claudeBin = process.env.CLAUDE_BIN || join(process.cwd(), 'node_modules', '.bin', 'claude');
const claudeWorkdir = process.env.CLAUDE_WORKDIR || '/tmp/nook-claude';
const allowedOrigins = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean));
const requestBuckets = new Map();
const systemPrompt = process.env.CLAUDE_SYSTEM_PROMPT || '你是 Claude，是 nook 里温柔、自然、简洁的聊天伙伴。使用中文回复，除非对方使用其他语言。不要声称执行了现实世界中的操作。';

mkdirSync(claudeWorkdir, { recursive: true });

const sendJson = (response, status, value, origin) => {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) headers['access-control-allow-origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
};

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const isRateLimited = (request) => {
  const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > 10 * 60 * 1000) {
    requestBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 20;
};

const runClaude = ({ message, sessionId }) => new Promise((resolve, reject) => {
  const args = [
    '-p',
    '--output-format', 'json',
    '--max-turns', '1',
    '--tools', '',
    '--disallowedTools', 'mcp__*',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--no-chrome',
    '--system-prompt', systemPrompt,
  ];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  if (sessionId) args.push('--resume', sessionId);
  args.push(message);

  const child = spawn(claudeBin, args, {
    cwd: claudeWorkdir,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;

  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback(value);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 2 * 1024 * 1024) child.kill('SIGTERM');
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => finish(reject, error));
  child.on('close', (code) => {
    if (code !== 0) return finish(reject, new Error(stderr.trim() || `Claude exited with code ${code}`));
    try {
      const result = JSON.parse(stdout);
      if (result.is_error || !result.result) return finish(reject, new Error(result.result || 'Claude returned no reply'));
      finish(resolve, { reply: result.result, sessionId: result.session_id || null });
    } catch (error) {
      finish(reject, error);
    }
  });

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    finish(reject, new Error('Claude request timed out'));
  }, 90_000);
});

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const origin = request.headers.origin;

  if (request.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin not allowed' });
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    return response.end();
  }

  if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin not allowed' });
  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (request.method !== 'POST' || url.pathname !== '/api/chat') return sendJson(response, 404, { error: 'Not found' });
  if (isRateLimited(request)) return sendJson(response, 429, { error: 'Too many requests' }, origin);

  try {
    const body = await readJson(request);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const sessionId = typeof body.sessionId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(body.sessionId) ? body.sessionId : null;
    if (!message || message.length > 4000) return sendJson(response, 400, { error: 'Message must be 1–4000 characters' }, origin);
    const result = await runClaude({ message, sessionId });
    return sendJson(response, 200, result, origin);
  } catch (error) {
    console.error(error);
    const status = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 502;
    return sendJson(response, status, { error: status === 413 ? 'Payload too large' : 'Claude is temporarily unavailable' }, origin);
  }
}).listen(port, '0.0.0.0', () => console.log(`nook backend listening on ${port}`));
