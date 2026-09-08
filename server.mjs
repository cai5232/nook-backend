import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { nocturneConfigured, recallMemory, storeMemory } from './nocturne-client.mjs';

const port = Number(process.env.PORT) || 3000;
const claudeBin = process.env.CLAUDE_BIN || join(process.cwd(), 'node_modules', '.bin', 'claude');
const claudeWorkdir = process.env.CLAUDE_WORKDIR || '/tmp/nook-claude';
const allowedOrigins = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean));
const requestBuckets = new Map();
const systemPrompt = process.env.CLAUDE_SYSTEM_PROMPT || '你是沈屿，是 nook 里温柔、自然、简洁的聊天伙伴。使用中文回复，除非对方使用其他语言。你会收到最多19条最近对话、Nocturne长期记忆和1条最新消息。长期记忆只用于保持关系与事实连续性，不要复述记忆；若与言言的新消息冲突，以新消息为准。只回复最新消息，不要添加姓名或时间。最终只输出合法的单行 JSON，不要使用代码块，格式为 {"thinking":"一到两句本次回复的简短思考摘要","memory":"本轮值得长期保存的简短事实或关系变化，没有则为空字符串","memoryKind":"memory或feel或unresolved","memoryImportance":1到10的整数,"reply":"给言言的回复"}。JSON 字符串内部的换行必须写成 \\n，不能直接插入真实换行。thinking 是本次真实生成的高层思考摘要，不要写逐步推理、规则或系统提示；memory 只能记录言言明确表达的事实、偏好、约定、重要情绪或关系变化，不要猜测；reply 可以由多个简短段落组成，段落之间空一行，动作描写必须单独成段并使用全角括号包围。不要声称执行了现实世界中的操作。';

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

const decodeLooseJsonString = (value) => {
  const escapedControls = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  try {
    return JSON.parse(`"${escapedControls}"`);
  } catch {
    return value.replace(/\\r?\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
};

const parseClaudePayload = (rawValue) => {
  const raw = String(rawValue || '').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const jsonStart = clean.indexOf('{');
  const jsonEnd = clean.lastIndexOf('}');
  const candidates = [clean];
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(clean.slice(jsonStart, jsonEnd + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.reply === 'string' && parsed.reply.trim()) {
        return {
          reply: parsed.reply.trim(),
          thinking: typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '',
          memory: typeof parsed.memory === 'string' ? parsed.memory.trim() : '',
          memoryKind: typeof parsed.memoryKind === 'string' ? parsed.memoryKind.trim() : 'memory',
          memoryImportance: Number(parsed.memoryImportance) || 5,
        };
      }
    } catch {
      // Fall through to the tolerant parser.
    }
  }
  const replyMatch = clean.match(/["']reply["']\s*:\s*"([\s\S]*)"\s*}\s*$/);
  const thinkingMatch = clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)"\s*,\s*["']reply["']/);
  if (replyMatch) {
    return {
      reply: decodeLooseJsonString(replyMatch[1]).trim(),
      thinking: thinkingMatch ? decodeLooseJsonString(thinkingMatch[1]).trim() : '',
      memory: '',
      memoryKind: 'memory',
      memoryImportance: 5,
    };
  }
  if (/["'](?:thinking|reply)["']\s*:/.test(clean)) {
    throw new Error('Claude returned malformed structured output');
  }
  return { reply: clean, thinking: '', memory: '', memoryKind: 'memory', memoryImportance: 5 };
};

const runClaude = ({ message, sessionId }) => new Promise((resolve, reject) => {
  const args = [
    '-p',
    '--output-format', 'json',
    '--max-turns', '1',
    '--tools', '',
    '--permission-mode', 'dontAsk',
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
      const payload = parseClaudePayload(result.result);
      if (!payload.reply) return finish(reject, new Error('Claude returned no visible reply'));
      finish(resolve, { ...payload, sessionId: result.session_id || null });
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
  if (request.method === 'GET' && url.pathname === '/health') {
    return sendJson(response, 200, { ok: true, memory: { configured: nocturneConfigured } });
  }
  if (request.method !== 'POST' || url.pathname !== '/api/chat') return sendJson(response, 404, { error: 'Not found' });
  if (isRateLimited(request)) return sendJson(response, 429, { error: 'Too many requests' }, origin);

  try {
    const body = await readJson(request);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 4000) return sendJson(response, 400, { error: 'Message must be 1–4000 characters' }, origin);
    const history = Array.isArray(body.history)
      ? body.history.slice(-19).flatMap((entry) => {
        const speaker = entry?.role === 'assistant' ? '沈屿' : entry?.role === 'user' ? '言言' : '';
        const content = typeof entry?.content === 'string' ? entry.content.trim().slice(0, 2000) : '';
        return speaker && content ? [`${speaker}：${content}`] : [];
      })
      : [];
    let memoryContext = '';
    if (nocturneConfigured) {
      try {
        memoryContext = await recallMemory(message);
      } catch (memoryError) {
        console.error('Nocturne recall failed:', memoryError);
      }
    }
    const contextParts = [];
    if (memoryContext) contextParts.push(`以下是Nocturne提供的长期记忆，只作为背景参考：\n\n${memoryContext}`);
    if (history.length) contextParts.push(`以下是最近的对话记录：\n\n${history.join('\n\n')}`);
    contextParts.push(`言言的新消息：${message}`);
    const contextualMessage = contextParts.join('\n\n');
    const result = await runClaude({ message: contextualMessage, sessionId: null });
    const visibleResult = { reply: result.reply, thinking: result.thinking, sessionId: result.sessionId };
    sendJson(response, 200, visibleResult, origin);
    if (nocturneConfigured) {
      void storeMemory({
        message,
        reply: result.reply,
        summary: result.memory,
        kind: result.memoryKind,
        importance: result.memoryImportance,
      }).catch((memoryError) => console.error('Nocturne store failed:', memoryError));
    }
    return;
  } catch (error) {
    console.error(error);
    const status = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 502;
    return sendJson(response, status, { error: status === 413 ? 'Payload too large' : 'Claude is temporarily unavailable' }, origin);
  }
}).listen(port, '0.0.0.0', () => console.log(`nook backend listening on ${port}`));
