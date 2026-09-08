const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_CHARS = 12_000;
const DEFAULT_BREATH_TTL_MS = 30 * 60 * 1_000;

const rawUrl = String(process.env.NOCTURNE_MCP_URL || '').trim();
const resolveMcpUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/$/, '');
    url.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
    return url;
  } catch (error) {
    console.error('Invalid NOCTURNE_MCP_URL:', error.message);
    return null;
  }
};
const mcpUrl = resolveMcpUrl(rawUrl);
const token = String(process.env.NOCTURNE_MCP_TOKEN || '').trim();
const timeoutMs = positiveInt(process.env.NOCTURNE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const contextChars = positiveInt(process.env.NOCTURNE_CONTEXT_CHARS, DEFAULT_CONTEXT_CHARS);
const breathTtlMs = positiveInt(process.env.NOCTURNE_BREATH_TTL_MS, DEFAULT_BREATH_TTL_MS);
const recallLimit = positiveInt(process.env.NOCTURNE_RECALL_LIMIT, 8);
let cachedBreath = { value: '', expiresAt: 0 };

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestHeaders(sessionId = '') {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function parseMcpBody(raw, contentType) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (!String(contentType || '').includes('text/event-stream')) return JSON.parse(text);

  const payloads = text
    .split(/\r?\n\r?\n/)
    .flatMap((event) => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
  return payloads.findLast((value) => value?.result || value?.error) || payloads.at(-1) || null;
}

async function postMcp(payload, sessionId = '') {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: requestHeaders(sessionId),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Nocturne MCP returned ${response.status}: ${raw.slice(0, 300)}`);
  return {
    payload: parseMcpBody(raw, response.headers.get('content-type')),
    sessionId: response.headers.get('mcp-session-id') || sessionId,
  };
}

async function closeMcpSession(sessionId) {
  if (!sessionId) return;
  try {
    await fetch(mcpUrl, {
      method: 'DELETE',
      headers: requestHeaders(sessionId),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
    });
  } catch {
    // Session cleanup must never make chat or memory operations fail.
  }
}

async function callTool(name, args = {}) {
  if (!mcpUrl) return '';
  const initialize = await postMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'nook-backend', version: '1.1.0' },
    },
  });
  if (initialize.payload?.error) throw new Error(initialize.payload.error.message || 'Nocturne MCP initialization failed');
  try {
    await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, initialize.sessionId);
    const called = await postMcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }, initialize.sessionId);
    if (called.payload?.error) throw new Error(called.payload.error.message || `Nocturne tool ${name} failed`);
    if (called.payload?.result?.isError) throw new Error(`Nocturne tool ${name} returned an error`);
    return (called.payload?.result?.content || [])
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();
  } finally {
    await closeMcpSession(initialize.sessionId);
  }
}

async function coreMemory() {
  const now = Date.now();
  if (cachedBreath.value && cachedBreath.expiresAt > now) return cachedBreath.value;
  const value = await callTool('breath');
  cachedBreath = { value, expiresAt: now + breathTtlMs };
  return value;
}

export const nocturneConfigured = Boolean(mcpUrl);

function isUsefulRecall(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !/(?:没有|未|无)(?:找到|检索到|匹配到|相关的?)(?:任何)?记忆|no (?:relevant )?(?:memory|memories|match)/i.test(text);
}

function compactEventText(value, limit = 240) {
  return String(value || '')
    .replace(/^#+\s*/gm, '')
    .replace(/【[^】]+】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export async function recallMemory(query) {
  if (!mcpUrl) return { context: '', surfaced: '' };
  const [core, related] = await Promise.allSettled([
    coreMemory(),
    callTool('trace', { query: String(query || '').slice(0, 800), limit: recallLimit }),
  ]);
  const sections = [];
  const coreBudget = Math.min(5_000, Math.floor(contextChars * 0.45));
  const relatedBudget = contextChars - coreBudget;
  if (core.status === 'fulfilled' && core.value) {
    sections.push(`【核心与浮现记忆】\n${core.value.slice(0, coreBudget)}`);
  }
  if (related.status === 'fulfilled' && related.value) {
    sections.push(`【与当前消息相关的记忆】\n${related.value.slice(0, relatedBudget)}`);
  }
  if (!sections.length) {
    const reason = core.status === 'rejected' ? core.reason : related.status === 'rejected' ? related.reason : null;
    if (reason) throw reason;
  }
  const relatedValue = related.status === 'fulfilled' && isUsefulRecall(related.value) ? related.value : '';
  const coreValue = core.status === 'fulfilled' && isUsefulRecall(core.value) ? core.value : '';
  return {
    context: sections.join('\n\n').slice(0, contextChars),
    surfaced: compactEventText(relatedValue || coreValue),
  };
}

export async function storeMemory({
  message = '',
  reply = '',
  summary = '',
  content = '',
  kind = 'memory',
  importance = 5,
  tags = 'nook,dialogue,auto',
}) {
  if (!mcpUrl) return '';
  const normalizedSummary = String(summary || '').trim();
  const normalizedContent = String(content || '').trim();
  if (!normalizedSummary && !normalizedContent) return '';
  const memoryContent = normalizedContent || (normalizedSummary
    ? `长期记忆摘要：${normalizedSummary}\n\n来源对话：\n言言：${message}\n沈屿：${reply}`
    : '');
  const validKinds = new Set(['memory', 'feel', 'writing', 'unresolved', 'window']);
  return callTool('hold', {
    content: memoryContent.slice(0, 3_500),
    kind: validKinds.has(kind) ? kind : 'memory',
    tags,
    importance: Math.max(1, Math.min(10, Number(importance) || 5)),
  });
}
