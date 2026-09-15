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
      if (typeof parsed?.reply === 'string' && parsed.reply.trim()) return {
        reply: parsed.reply.trim(),
        thinking: typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '',
        imageDescriptions: normalizeImageDescriptions(parsed.imageDescriptions, attachments),
      };
    } catch {}
  }
  const replyMatch = clean.match(/["']reply["']\s*:\s*"([\s\S]*)"\s*}\s*$/);
  const thinkingMatch = clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)"\s*,\s*["']reply["']/);
  if (replyMatch) return {
    reply: decodeLooseJsonString(replyMatch[1]).trim(),
    thinking: thinkingMatch ? decodeLooseJsonString(thinkingMatch[1]).trim() : '',
    imageDescriptions: {},
  };
  if (/["'](?:thinking|reply)["']\s*:/.test(clean)) throw new Error('Model returned malformed structured output');
  return { reply: clean, thinking: '', imageDescriptions: {} };
};
