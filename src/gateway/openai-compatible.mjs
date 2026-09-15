const apiKey = String(process.env.AI_API_KEY || '').trim();
export const aiBaseUrl = String(process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
export const aiModel = String(process.env.AI_MODEL || '').trim();
export const aiConfigured = Boolean(apiKey && aiBaseUrl && aiModel);

const metricsFromUsage = (usage = {}) => {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cacheReadTokens = Number(
    usage?.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.input_cache_read ??
    usage.cache_read ??
    usage.cacheReadInputTokens ??
    0
  ) || 0;
  const cacheCreatedTokens = Number(
    usage.cache_creation_input_tokens ??
    usage.cache_creation_tokens ??
    usage.input_cache_write ??
    usage.input_cache_write_5_min ??
    usage.input_cache_write_1_h ??
    usage.cache_write ??
    usage.cacheCreatedInputTokens ??
    0
  ) || 0;
  const denominator = inputTokens || (cacheReadTokens + cacheCreatedTokens);
  const hasCacheMetrics =
    usage?.prompt_tokens_details?.cached_tokens != null ||
    usage.cache_read_input_tokens != null ||
    usage.cache_creation_input_tokens != null ||
    usage.cache_creation_tokens != null ||
    usage.input_cache_read != null ||
    usage.input_cache_write != null ||
    usage.input_cache_write_5_min != null ||
    usage.input_cache_write_1_h != null ||
    usage.cache_read != null ||
    usage.cache_write != null;
  return {
    tokens: Number(usage.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreatedTokens,
    cacheRate: hasCacheMetrics && denominator ? cacheReadTokens / denominator : null
  };
};

const contentText = content => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('').trim();
};

const cacheEnabled = () => {
  const override = String(process.env.AI_PROMPT_CACHE || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(override)) return false;
  if (['1', 'true', 'on', 'yes'].includes(override)) return true;
  return /(^|\/)claude(?:-|$)/i.test(aiModel) || /anthropic/i.test(aiModel);
};

const cachedSystemContent = systemPrompt => cacheEnabled()
  ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
  : systemPrompt;

export const runModel = async ({ systemPrompt, messages }) => {
  if (!aiConfigured) throw new Error('AI_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 120000);
  try {
    const response = await fetch(`${aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: aiModel,
        messages: [{ role: 'system', content: cachedSystemContent(systemPrompt) }, ...messages],
        temperature: Number(process.env.AI_TEMPERATURE ?? 0.8),
        max_tokens: Number(process.env.AI_MAX_TOKENS) || 1800
      }),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `AI_REQUEST_FAILED_${response.status}`);
    const choice = result?.choices?.[0];
    const text = contentText(choice?.message?.content);
    if (!text) throw new Error('AI_EMPTY_RESPONSE');
    return { text, model: result?.model || aiModel, metrics: metricsFromUsage(result?.usage || {}) };
  } finally {
    clearTimeout(timeout);
  }
};
