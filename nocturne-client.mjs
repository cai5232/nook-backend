const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_CHARS = 12_000;

const rawUrl = String(process.env.NOCTURNE_API_URL || '').trim();
const token = String(process.env.NOCTURNE_API_TOKEN || '').trim();
const timeoutMs = positiveInt(process.env.NOCTURNE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const contextChars = positiveInt(process.env.NOCTURNE_CONTEXT_CHARS, DEFAULT_CONTEXT_CHARS);
const recallLimit = positiveInt(process.env.NOCTURNE_RECALL_LIMIT, 8);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveApiUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/(?:mcp)?\/?$/, '');
    return url;
  } catch (error) {
    console.error('Invalid NOCTURNE_API_URL:', error.message);
    return null;
  }
}

const apiUrl = resolveApiUrl(rawUrl);

function endpoint(pathname) {
  const url = new URL(apiUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${pathname}`;
  return url;
}

async function post(pathname, body) {
  const response = await fetch(endpoint(pathname), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Nocturne direct API returned ${response.status}: ${raw.slice(0, 300)}`);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Nocturne direct API returned invalid JSON');
  }
}

export const nocturneConfigured = Boolean(apiUrl && token);
export const nocturneMode = 'direct-http';

function compactEventText(value, limit = 240) {
  return String(value || '')
    .replace(/^#+\s*/gm, '')
    .replace(/【[^】]+】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function normalizeRecall(payload) {
  const core = String(payload?.core || '').trim();
  const related = Array.isArray(payload?.memories)
    ? payload.memories.map((item) => typeof item === 'string' ? item : item?.content || item?.text || '').filter(Boolean).join('\n\n')
    : String(payload?.related || '').trim();
  const suppliedContext = String(payload?.context || '').trim();
  const sections = [];
  if (core) sections.push(`【核心记忆】\n${core}`);
  if (related) sections.push(`【与当前消息相关的记忆】\n${related}`);
  if (!sections.length && suppliedContext) sections.push(suppliedContext);
  return {
    context: sections.join('\n\n').slice(0, contextChars),
    surfaced: compactEventText(payload?.surfaced || related || core),
  };
}

export async function recallMemory(query) {
  if (!apiUrl) return { context: '', surfaced: '' };
  const payload = await post('/api/integrations/nook/recall', {
    query: String(query || '').slice(0, 800),
    limit: recallLimit,
    contextChars,
  });
  return normalizeRecall(payload);
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
  if (!apiUrl) return '';
  const normalizedSummary = String(summary || '').trim();
  const normalizedContent = String(content || '').trim();
  if (!normalizedSummary && !normalizedContent) return '';
  const memoryContent = normalizedContent || `长期记忆摘要：${normalizedSummary}\n\n来源对话：\n言言：${message}\n沈屿：${reply}`;
  const validKinds = new Set(['memory', 'feel', 'writing', 'unresolved', 'window']);
  const payload = await post('/api/integrations/nook/memories', {
    content: memoryContent.slice(0, 3_500),
    kind: validKinds.has(kind) ? kind : 'memory',
    tags,
    importance: Math.max(1, Math.min(10, Number(importance) || 5)),
    source: 'nook',
  });
  return String(payload?.message || payload?.id || 'saved');
}
