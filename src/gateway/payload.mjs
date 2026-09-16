const decodeLooseJsonString = (value) => {
  const escaped = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  try { return JSON.parse(`"${escaped}"`); }
  catch { return value.replace(/\\r?\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
};

const normalizeImageDescriptions = (value, attachments = []) => {
  const ids = new Set(attachments.map((item) => item.id));
  const result = {};
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (ids.has(item?.id) && typeof item.description === 'string' && item.description.trim()) {
      result[item.id] = item.description.trim().slice(0, 1600);
    }
  }
  return result;
};

const separateThinkingFromReply = (replyValue, thinkingValue = '') => {
  let reply = String(replyValue || '');
  const leaked = [];

  // Treat model-emitted thinking/reasoning blocks as metadata, never visible chat text.
  reply = reply.replace(/<(?:thinking|reasoning|analysis)\b[^>]*>([\s\S]*?)<\/(?:thinking|reasoning|analysis)>/gi, (_, body) => {
    const text = String(body || '').trim();
    if (text) leaked.push(text);
    return '';
  });

  // Defensive cleanup for orphan tags without exposing their markup in the bubble.
  reply = reply.replace(/<\/?(?:thinking|reasoning|analysis)\b[^>]*>/gi, '');
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();

  const explicitThinking = String(thinkingValue || '').trim();
  const thinking = [explicitThinking, ...leaked]
    .filter(Boolean)
    .filter((text, index, list) => list.indexOf(text) === index)
    .join('\n\n')
    .trim();

  return { reply, thinking };
};

const finalizePayload = ({ reply, thinking = '', imageDescriptions = {} }) => {
  const separated = separateThinkingFromReply(reply, thinking);
  return { reply: separated.reply, thinking: separated.thinking, imageDescriptions };
};

// Try to find and parse the outermost JSON object from a string that may
// contain surrounding text or multiple JSON-like fragments.
const extractJsonObject = (text) => {
  // Fast path: the whole string is valid JSON
  try { return JSON.parse(text); } catch {}

  // Walk the string looking for balanced { … } blocks, largest first
  const attempts = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        attempts.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Try longest candidate first
  attempts.sort((a, b) => b.length - a.length);
  for (const candidate of attempts) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
};

export const parseModelPayload = (rawValue, attachments = []) => {
  const raw = String(rawValue || '').trim();
  // Strip markdown code fences
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Attempt 1: structured JSON extraction (robust, handles surrounding text)
  const parsed = extractJsonObject(clean);
  if (parsed && typeof parsed?.reply === 'string' && parsed.reply.trim()) {
    return finalizePayload({
      reply: parsed.reply.trim(),
      thinking: typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '',
      imageDescriptions: normalizeImageDescriptions(parsed.imageDescriptions, attachments),
    });
  }

  // Attempt 2: regex fallback – extract thinking first (non-greedy), then reply (last occurrence)
  const thinkingMatch = clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)(?<!\\)",\s*["']reply["']/);
  // Use a non-greedy match anchored to the last "reply" field to avoid over-capture
  const replyMatch = clean.match(/["']reply["']\s*:\s*"([\s\S]*?)(?<!\\)"\s*(?:,|\})/);
  if (replyMatch) {
    return finalizePayload({
      reply: decodeLooseJsonString(replyMatch[1]).trim(),
      thinking: thinkingMatch ? decodeLooseJsonString(thinkingMatch[1]).trim() : '',
      imageDescriptions: {},
    });
  }

  // Attempt 3: if the output looks like it was *trying* to be JSON, surface the error
  if (/["'](?:thinking|reply)["']\s*:/.test(clean)) throw new Error('Model returned malformed structured output');

  // Attempt 4: treat the whole output as plain-text reply
  return finalizePayload({ reply: clean, thinking: '', imageDescriptions: {} });
};
