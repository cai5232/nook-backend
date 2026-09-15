import { createHash } from 'node:crypto';

const apiKey = String(process.env.AI_API_KEY || '').trim();
export const aiBaseUrl = String(process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
export const aiModel = String(process.env.AI_MODEL || '').trim();
export const aiConfigured = Boolean(apiKey && aiBaseUrl && aiModel);

const metricsFromUsage = (usage = {}) => {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const openAiCachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  const cacheReadTokens = Number(openAiCachedTokens ?? usage.cache_read_input_tokens ?? usage.input_cache_read ?? usage.cache_read ?? usage.cacheReadInputTokens ?? 0) || 0;
  const explicitCacheWrite = usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? usage.input_cache_write ?? usage.cache_write ?? usage.cacheCreatedInputTokens;
  const timedCacheWrite = (Number(usage.input_cache_write_5_min) || 0) + (Number(usage.input_cache_write_1_h) || 0);
  const cacheCreatedTokens = Number(explicitCacheWrite ?? timedCacheWrite) || 0;
  const hasAnthropicCacheMetrics = usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null || usage.cache_creation_tokens != null || usage.input_cache_read != null || usage.input_cache_write != null || usage.input_cache_write_5_min != null || usage.input_cache_write_1_h != null || usage.cache_read != null || usage.cache_write != null;
  const hasOpenAiCacheMetrics = openAiCachedTokens != null;
  const hasCacheMetrics = hasAnthropicCacheMetrics || hasOpenAiCacheMetrics;
  const logicalInputTokens = hasAnthropicCacheMetrics ? inputTokens + cacheReadTokens + cacheCreatedTokens : inputTokens;
  const cacheRate = hasCacheMetrics && logicalInputTokens > 0 ? cacheReadTokens / logicalInputTokens : null;
  return { tokens: Number(usage.total_tokens) || logicalInputTokens + outputTokens, inputTokens: logicalInputTokens, uncachedInputTokens: inputTokens, outputTokens, cacheReadTokens, cacheCreatedTokens, cacheRate };
};

const contentText = content => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('').trim();
};
const hash = value => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0,16);
const cacheEnabled = () => {
  const override = String(process.env.AI_PROMPT_CACHE || '').trim().toLowerCase();
  if (['0','false','off','no'].includes(override)) return false;
  if (['1','true','on','yes'].includes(override)) return true;
  return /(^|\/)claude(?:-|$)/i.test(aiModel) || /anthropic/i.test(aiModel);
};
const cachedSystemContent = systemPrompt => cacheEnabled() ? [{ type:'text', text:systemPrompt, cache_control:{ type:'ephemeral' } }] : systemPrompt;
const asBlocks = content => Array.isArray(content) ? content.map(part => typeof part === 'string' ? { type:'text', text:part } : { ...part }) : [{ type:'text', text:String(content ?? '') }];

// Keep the dynamic current user turn outside cache. The previous complete conversation
// is a stable prefix on the next request, so put a breakpoint at its end. Claude can reuse
// the longest matching prefix and only create/cache the newly appended history delta.
const withConversationBreakpoint = messages => {
  if (!cacheEnabled() || !Array.isArray(messages) || messages.length < 2) return messages;
  const copy = messages.map(message => ({ ...message, content:Array.isArray(message.content) ? message.content.map(part => typeof part === 'object' && part ? { ...part } : part) : message.content }));
  const stableEnd = copy.length - 2;
  const target = copy[stableEnd];
  if (!target || !['user','assistant'].includes(target.role)) return copy;
  const blocks = asBlocks(target.content);
  if (!blocks.length) return copy;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control:{ type:'ephemeral' } };
  target.content = blocks;
  return copy;
};

const cacheDiagnostics = (systemPrompt, messages) => {
  const stableHistory = Array.isArray(messages) && messages.length > 1 ? messages.slice(0,-1) : [];
  const stableHistoryText = stableHistory.map(m => `${m.role}:${contentText(m.content)}`).join('\n');
  return { systemHash:hash(systemPrompt), systemChars:String(systemPrompt ?? '').length, historyHash:hash(stableHistoryText), historyChars:stableHistoryText.length, stableMessages:stableHistory.length, dynamicMessages:Array.isArray(messages)&&messages.length?1:0 };
};

export const runModel = async ({ systemPrompt, messages }) => {
  if (!aiConfigured) throw new Error('AI_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 120000);
  const diagnostics = cacheDiagnostics(systemPrompt,messages);
  const requestMessages = [{ role:'system', content:cachedSystemContent(systemPrompt) }, ...withConversationBreakpoint(messages)];
  console.log('[prompt-cache request]', JSON.stringify({ model:aiModel, cacheEnabled:cacheEnabled(), ...diagnostics, breakpoints:cacheEnabled() ? (messages.length>1?2:1) : 0 }));
  try {
    const response = await fetch(`${aiBaseUrl}/chat/completions`, { method:'POST', headers:{ authorization:`Bearer ${apiKey}`, 'content-type':'application/json' }, body:JSON.stringify({ model:aiModel, messages:requestMessages, temperature:Number(process.env.AI_TEMPERATURE ?? 0.8), max_tokens:Number(process.env.AI_MAX_TOKENS)||1800 }), signal:controller.signal });
    const result = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `AI_REQUEST_FAILED_${response.status}`);
    const text = contentText(result?.choices?.[0]?.message?.content);
    if (!text) throw new Error('AI_EMPTY_RESPONSE');
    const metrics = metricsFromUsage(result?.usage || {});
    console.log('[prompt-cache usage]', JSON.stringify({ model:result?.model||aiModel, prompt:metrics.uncachedInputTokens, cache_read:metrics.cacheReadTokens, cache_write:metrics.cacheCreatedTokens, cache_hit_rate:metrics.cacheRate == null ? null : Number((metrics.cacheRate*100).toFixed(2)), ...diagnostics }));
    return { text, model:result?.model||aiModel, metrics };
  } finally { clearTimeout(timeout); }
};
