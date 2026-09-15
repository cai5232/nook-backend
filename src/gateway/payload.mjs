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

export const parseModelPayload = (rawValue, attachments = []) => {
  const raw = String(rawValue || '').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [clean];
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.reply === 'string' && parsed.reply.trim()) return finalizePayload({
        reply: parsed.reply.trim(),
        thinking: typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '',
        imageDescriptions: normalizeImageDescriptions(parsed.imageDescriptions, attachments),
      });
    } catch {}
  }
  const replyMatch = clean.match(/["']reply["']\s*:\s*"([\s\S]*)"\s*}\s*$/);
  const thinkingMatch = clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)"\s*,\s*["']reply["']/);
  if (replyMatch) return finalizePayload({
    reply: decodeLooseJsonString(replyMatch[1]).trim(),
    thinking: thinkingMatch ? decodeLooseJsonString(thinkingMatch[1]).trim() : '',
    imageDescriptions: {},
  });
  if (/["'](?:thinking|reply)["']\s*:/.test(clean)) throw new Error('Model returned malformed structured output');
  return finalizePayload({ reply: clean, thinking: '', imageDescriptions: {} });
};
