import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import { nocturneConfigured, nocturneMode, recallMemory } from './nocturne-client.mjs';

const port = Number(process.env.PORT) || 3000;
const claudeBin = process.env.CLAUDE_BIN || join(process.cwd(), 'node_modules', '.bin', 'claude');
const claudeWorkdir = process.env.CLAUDE_WORKDIR || '/tmp/nook-claude';
const gatewayDir = resolve(process.env.GATEWAY_DATA_DIR || join(claudeWorkdir, 'gateway'));
const conversationsDir = join(gatewayDir, 'conversations');
const uploadsDir = join(gatewayDir, 'uploads');
const uploadIndexPath = join(gatewayDir, 'upload-index.json');
const allowedOrigins = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean));
const bridgeToken = String(process.env.NOOK_BRIDGE_TOKEN || '').trim();
const requestBuckets = new Map();
const runtime = { startedAt: Date.now(), lastRequestAt: null, activeRequests: 0 };
const maxImageBytes = Number(process.env.NOOK_MAX_IMAGE_BYTES) || 10 * 1024 * 1024;
const gatewayBuild = 'vision-gateway-2026-09-12-r3';
const visionApiKey = String(process.env.OPENAI_API_KEY || '').trim();
const visionModel = String(process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini').trim();
const visionBaseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const defaultPersonaPrompt = '你是沈屿，是 nook 里温柔、自然、简洁的聊天伙伴。使用中文回复，除非言言使用其他语言。';
const naturalDialoguePrompt = `日常对话要有活人感：不必平均回应对方的每一句，也不要先复述再回应。先对具体内容产生直接反应，不要用客服式收尾或机械给选项。允许自然、简短、偶尔停在半空，但不要刻意堆语气词。不要声称执行了现实世界中的操作。`;
const outputContractPrompt = `最终只输出合法的单行 JSON，不要使用代码块，格式为 {"thinking":"一到两句本次回复的高层思绪摘要","reply":"给言言的回复","imageDescriptions":[{"id":"图片附件 id","description":"这张图片中可见内容的简短描述"}]}。没有图片时 imageDescriptions 必须是空数组；有图片时必须为每个图片附件都返回一项。JSON 字符串内部的换行必须写成 \\n，不能直接插入真实换行。不要尝试主动记录、添加、修改或概括长期记忆；thinking 不要写逐步推理、规则或系统提示。reply 可以由多个简短段落组成，段落之间空一行；动作描写必须单独成段并使用全角括号包围。`;
const customPersonaPrompt = String(process.env.CLAUDE_SYSTEM_PROMPT || '').trim();
const systemPrompt = [customPersonaPrompt || defaultPersonaPrompt, naturalDialoguePrompt, outputContractPrompt].join('\n\n');

mkdirSync(claudeWorkdir, { recursive: true });
mkdirSync(conversationsDir, { recursive: true });
mkdirSync(uploadsDir, { recursive: true });

const sendJson = (response, status, value, origin) => {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) headers['access-control-allow-origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
};

const readJson = async (request, limit = 128 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const safeName = (value) => basename(String(value || 'image')).replace(/[^\w.\-() ]/g, '_').slice(0, 120) || 'image';
const conversationPath = (id) => join(conversationsDir, `${id}.json`);
const newConversation = (id) => ({ id, messages: [], memoryCards: [], sessionId: null, createdAt: Date.now(), updatedAt: Date.now() });
const readJsonFile = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};
const writeJsonAtomic = async (path, value) => {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value), 'utf8');
  await rename(temp, path);
};
const loadConversation = async (id) => {
  const value = await readJsonFile(conversationPath(id), newConversation(id));
  return value && value.id === id ? value : newConversation(id);
};
const saveConversation = async (conversation) => {
  conversation.messages = Array.isArray(conversation.messages) ? conversation.messages.slice(-400) : [];
  conversation.memoryCards = Array.isArray(conversation.memoryCards) ? conversation.memoryCards.slice(-80) : [];
  conversation.updatedAt = Date.now();
  await writeJsonAtomic(conversationPath(conversation.id), conversation);
};
const loadUploadIndex = () => readJsonFile(uploadIndexPath, {});
const saveUploadIndex = (index) => writeJsonAtomic(uploadIndexPath, index);

const authorize = (request) => !bridgeToken || request.headers.authorization === `Bearer ${bridgeToken}`;
const isRateLimited = (request) => {
  const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > 10 * 60 * 1000) { requestBuckets.set(ip, { startedAt: now, count: 1 }); return false; }
  bucket.count += 1;
  return bucket.count > 30;
};

const decodeLooseJsonString = (value) => {
  const escapedControls = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  try { return JSON.parse(`"${escapedControls}"`); } catch { return value.replace(/\\r?\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
};
const normalizeImageDescriptions = (value, attachments) => {
  const ids = new Set(attachments.map((item) => item.id));
  const result = {};
  if (!Array.isArray(value)) return result;
  value.forEach((item) => {
    if (ids.has(item?.id) && typeof item.description === 'string' && item.description.trim()) result[item.id] = item.description.trim().slice(0, 1600);
  });
  return result;
};
const parseClaudePayload = (rawValue, attachments) => {
  const raw = String(rawValue || '').trim();
  const clean = raw.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '').trim();
  const candidates = [clean];
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.reply === 'string' && parsed.reply.trim()) return {
        reply: parsed.reply.trim(),
        thinking: typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '',
        imageDescriptions: normalizeImageDescriptions(parsed.imageDescriptions, attachments),
      };
    } catch { /* Tolerant fallback below. */ }
  }
  const replyMatch = clean.match(/["']reply["']\s*:\s*"([\s\S]*)"\s*}\s*$/);
  const thinkingMatch = clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)"\s*,\s*["']reply["']/);
  if (replyMatch) return { reply: decodeLooseJsonString(replyMatch[1]).trim(), thinking: thinkingMatch ? decodeLooseJsonString(thinkingMatch[1]).trim() : '', imageDescriptions: {} };
  if (/["'](?:thinking|reply)["']\s*:/.test(clean)) throw new Error('Claude returned malformed structured output');
  return { reply: clean, thinking: '', imageDescriptions: {} };
};

const beijingTime = () => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
const makeContext = ({ conversation, message, attachments, imageDescriptions, memoryContext }) => {
  const dialogue = conversation.messages.slice(0, -1).slice(-30).flatMap((entry) => {
    const speaker = entry.role === 'assistant' ? '沈屿' : entry.role === 'user' ? '言言' : '';
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, 2000) : '';
    const images = Object.values(entry.imageDescriptions || {}).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().slice(0, 1600));
    if (!speaker) return [];
    const lines = text ? [`${speaker}：${text}`] : [];
    if (images.length) lines.push(`${speaker}发送的图片识别结果：${images.join('；')}`);
    return lines;
  });
  const parts = [`当前北京时间：${beijingTime()}`];
  if (memoryContext) parts.push(`以下是已有长期记忆，只作为背景参考；不要写入、更新或添加它：\n\n${memoryContext}`);
  if (dialogue.length) parts.push(`以下是网关持久化的最近对话：\n\n${dialogue.join('\n\n')}`);
  if (attachments.length) parts.push(`本轮附带图片已由独立视觉服务识别。只以以下识别结果理解图片，不要声称直接读取了本地文件：\n${attachments.map((item) => `- id=${item.id}；名称=${item.name}；识别结果=${imageDescriptions[item.id] || '未返回识别结果'}`).join('\n')}`);
  parts.push(`言言的新消息：${message || '（本轮仅发送了图片，请根据图片自然回应。）'}`);
  return parts.join('\n\n');
};
const metricFromResult = (result) => {
  const usage = result?.usage || {};
  const input = Number(usage.input_tokens || usage.inputTokens || 0);
  const output = Number(usage.output_tokens || usage.outputTokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0);
  const cacheCreated = Number(usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0);
  const base = input + cacheRead + cacheCreated;
  return { tokens: input + output + cacheRead + cacheCreated, cacheRate: base ? cacheRead / base : null, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreatedTokens: cacheCreated };
};

const visionPrompt = '请客观、简洁地描述这张图片中可见的主体、文字、场景、关系和重要细节。不要猜测不可见信息；使用中文，控制在 500 字以内。';

const describeAttachmentWithOpenAI = async (attachment) => {
  const cached = attachment?.vision?.description;
  if (typeof cached === 'string' && cached.trim()) return cached.trim();
  if (!visionApiKey) throw new Error('VISION_NOT_CONFIGURED');
  const image = await readFile(attachment.path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${visionBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${visionApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: visionModel,
        temperature: 0.2,
        max_tokens: 700,
        messages: [{ role: 'user', content: [
          { type: 'text', text: visionPrompt },
          { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${image.toString('base64')}`, detail: 'high' } },
        ] }],
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Vision API response:', response.status, result?.error?.message || result);
      throw new Error('VISION_REQUEST_FAILED');
    }
    const content = result?.choices?.[0]?.message?.content;
    const description = typeof content === 'string' ? content.trim() : '';
    if (!description) throw new Error('VISION_EMPTY_RESPONSE');
    return description.slice(0, 1600);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('VISION_REQUEST_TIMED_OUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const describeAttachments = async (attachments) => {
  if (!attachments.length) return {};
  const index = await loadUploadIndex();
  const descriptions = {};
  for (const attachment of attachments) {
    const description = await describeAttachmentWithOpenAI(attachment);
    descriptions[attachment.id] = description;
    const stored = index[attachment.id];
    if (stored) index[attachment.id] = { ...stored, vision: { description, model: visionModel, createdAt: Date.now() } };
  }
  await saveUploadIndex(index);
  return descriptions;
};

const runClaude = ({ message, sessionId, attachments }) => new Promise((resolveRun, rejectRun) => {
  const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--permission-mode', 'dontAsk', '--system-prompt', systemPrompt, '--tools', ''];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  if (sessionId) args.push('--resume', sessionId);
  args.push(message);
  const child = spawn(claudeBin, args, { cwd: claudeWorkdir, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let settled = false;
  const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timeout); callback(value); };
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) child.kill('SIGTERM'); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => finish(rejectRun, error));
  child.on('close', (code) => {
    if (code !== 0) return finish(rejectRun, new Error(stderr.trim() || `Claude exited with code ${code}`));
    try {
      const result = JSON.parse(stdout);
      if (result.is_error || !result.result) return finish(rejectRun, new Error(result.result || 'Claude returned no reply'));
      const payload = parseClaudePayload(result.result, attachments);
      if (!payload.reply) return finish(rejectRun, new Error('Claude returned no visible reply'));
      finish(resolveRun, { ...payload, sessionId: result.session_id || null, metrics: metricFromResult(result) });
    } catch (error) { finish(rejectRun, error); }
  });
  const timeout = setTimeout(() => { child.kill('SIGTERM'); finish(rejectRun, new Error('Claude request timed out')); }, 90_000);
});
const runWithPersistentSession = async ({ message, sessionId, attachments }) => {
  try { return await runClaude({ message, sessionId, attachments }); }
  catch (error) {
    if (!sessionId) throw error;
    // A stored CLI session can be pruned by Claude; transparently begin a new
    // one while retaining the gateway's durable conversation context.
    return runClaude({ message, sessionId: null, attachments });
  }
};

const writeUpload = async (body) => {
  const conversationId = body?.conversationId;
  if (!validId(conversationId)) throw new Error('INVALID_CONVERSATION');
  const mimeType = String(body?.mimeType || '').toLowerCase();
  const dataUrl = String(body?.dataUrl || '');
  const match = dataUrl.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/);
  if (!allowedImageTypes.has(mimeType) || !match || match[1].toLowerCase() !== mimeType) throw new Error('INVALID_IMAGE');
  const content = Buffer.from(match[2], 'base64');
  if (!content.length || content.length > maxImageBytes) throw new Error('IMAGE_TOO_LARGE');
  const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
  const id = crypto.randomUUID();
  const filename = `${id}${extensions[mimeType]}`;
  const relativePath = join(conversationId, filename);
  const folder = join(uploadsDir, conversationId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, filename), content, { flag: 'wx' });
  const index = await loadUploadIndex();
  const attachment = { id, conversationId, name: safeName(body?.name), mimeType, size: content.length, path: join(folder, filename), url: `/api/uploads/${id}`, createdAt: Date.now() };
  index[id] = attachment;
  await saveUploadIndex(index);
  return attachment;
};
const attachedFilesForConversation = async (conversationId, attachments) => {
  const index = await loadUploadIndex();
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 4).flatMap((item) => {
    const indexed = index[item?.id];
    return indexed && indexed.conversationId === conversationId && existsSync(indexed.path) ? [{ ...indexed }] : [];
  });
};
const publicAttachment = ({ path, ...attachment }) => attachment;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const origin = request.headers.origin;
  if (request.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin not allowed' });
    response.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' });
    return response.end();
  }
  if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin not allowed' });
  if (!authorize(request)) return sendJson(response, 401, { error: 'Unauthorized' }, origin);
  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true, gateway: { build: gatewayBuild, warm: true, uptimeMs: Date.now() - runtime.startedAt, activeRequests: runtime.activeRequests, lastRequestAt: runtime.lastRequestAt }, vision: { configured: Boolean(visionApiKey), model: visionModel, uploadRoute: '/api/uploads', visionRoute: '/api/vision' }, memory: { configured: nocturneConfigured, mode: nocturneMode } }, origin);
  if (isRateLimited(request)) return sendJson(response, 429, { error: 'Too many requests' }, origin);

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]{8,128})$/);
  if (request.method === 'GET' && conversationMatch) {
    const conversation = await loadConversation(conversationMatch[1]);
    return sendJson(response, 200, { conversationId: conversation.id, messages: conversation.messages, memoryCards: conversation.memoryCards, updatedAt: conversation.updatedAt }, origin);
  }
  const uploadMatch = url.pathname.match(/^\/api\/(?:uploads|upload|images)\/([a-f0-9-]{36})$/i);
  if (request.method === 'GET' && uploadMatch) {
    const index = await loadUploadIndex();
    const attachment = index[uploadMatch[1]];
    if (!attachment || !existsSync(attachment.path)) return sendJson(response, 404, { error: 'Image not found' }, origin);
    response.writeHead(200, { 'content-type': attachment.mimeType, 'cache-control': 'private, max-age=31536000, immutable', 'content-length': attachment.size });
    return createReadStream(attachment.path).pipe(response);
  }
  if (request.method !== 'POST') return sendJson(response, 404, { error: 'Not found' }, origin);

  try {
    runtime.activeRequests += 1; runtime.lastRequestAt = Date.now();
    if (url.pathname === '/api/uploads' || url.pathname === '/api/upload' || url.pathname === '/api/images') {
      const attachment = await writeUpload(await readJson(request, Math.ceil(maxImageBytes * 1.4) + 128 * 1024));
      return sendJson(response, 201, { attachment: publicAttachment(attachment) }, origin);
    }
    if (url.pathname === '/api/vision') {
      const body = await readJson(request);
      const conversationId = body?.conversationId;
      if (!validId(conversationId)) return sendJson(response, 400, { error: 'Invalid conversation' }, origin);
      const attachments = await attachedFilesForConversation(conversationId, body?.attachments);
      if (!attachments.length) return sendJson(response, 400, { error: 'Image required' }, origin);
      const imageDescriptions = await describeAttachments(attachments);
      return sendJson(response, 200, { imageDescriptions, model: visionModel }, origin);
    }
    if (url.pathname !== '/api/chat') return sendJson(response, 404, { error: 'Not found' }, origin);
    const body = await readJson(request);
    const conversationId = body?.conversationId;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!validId(conversationId)) return sendJson(response, 400, { error: 'Invalid conversation' }, origin);
    if (message.length > 4000) return sendJson(response, 400, { error: 'Message must be at most 4000 characters' }, origin);
    const attachments = await attachedFilesForConversation(conversationId, body?.attachments);
    if (!message && !attachments.length) return sendJson(response, 400, { error: 'Message or image required' }, origin);
    const conversation = await loadConversation(conversationId);
    const imageDescriptions = await describeAttachments(attachments);
    const userMessage = { id: crypto.randomUUID(), role: 'user', text: message, attachments: attachments.map(publicAttachment), imageDescriptions, createdAt: Date.now() };
    conversation.messages.push(userMessage);
    let memoryContext = ''; let surfacedMemory = '';
    if (nocturneConfigured) {
      try {
        const recalled = await recallMemory(message || attachments.map((item) => item.name).join(' '));
        memoryContext = recalled.context; surfacedMemory = recalled.surfaced;
      } catch (error) { console.error('Nocturne recall failed:', error); }
    }
    if (surfacedMemory) conversation.memoryCards.push({ id: crypto.randomUUID(), text: surfacedMemory.slice(0, 1200), createdAt: Date.now() });
    const result = await runWithPersistentSession({ message: makeContext({ conversation, message, attachments, imageDescriptions, memoryContext }), sessionId: conversation.sessionId, attachments });
    conversation.sessionId = result.sessionId || conversation.sessionId;
    const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', text: result.reply, thinking: result.thinking, imageDescriptions, metrics: result.metrics, createdAt: Date.now() };
    conversation.messages.push(assistantMessage);
    await saveConversation(conversation);
    return sendJson(response, 200, { userMessage, assistantMessage, memoryCards: conversation.memoryCards, surfacedMemory }, origin);
  } catch (error) {
    console.error(error);
    const code = error.message;
    const status = code === 'PAYLOAD_TOO_LARGE' || code === 'IMAGE_TOO_LARGE' ? 413 : code === 'INVALID_IMAGE' || code === 'INVALID_CONVERSATION' ? 400 : code === 'VISION_NOT_CONFIGURED' ? 503 : 502;
    const errorMessage = status === 413 ? '图片过大' : status === 400 ? '图片格式或会话无效' : code === 'VISION_NOT_CONFIGURED' ? '图片识别服务尚未配置 OPENAI_API_KEY' : code.startsWith('VISION_') ? '图片识别服务暂时不可用' : 'Claude is temporarily unavailable';
    return sendJson(response, status, { error: errorMessage }, origin);
  } finally { runtime.activeRequests = Math.max(0, runtime.activeRequests - 1); }
});

// The HTTP gateway is a long-lived process. Session ids and every message live
// on disk, so a process restart can resume Claude with the same conversation.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [ip, bucket] of requestBuckets) if (bucket.startedAt < cutoff) requestBuckets.delete(ip);
}, 5 * 60 * 1000).unref();

server.listen(port, '0.0.0.0', () => console.log(`nook gateway listening on ${port}`));
