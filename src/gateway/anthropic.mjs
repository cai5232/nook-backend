const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
const baseUrl = String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const model = String(process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5').trim();
const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS) || 2048;

export const anthropicConfigured = Boolean(apiKey);
export const anthropicModel = model;

const metricsFromUsage = (usage = {}) => {
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheCreated = Number(usage.cache_creation_input_tokens || 0);
  const cacheBase = input + cacheRead + cacheCreated;
  return {
    tokens: input + output + cacheRead + cacheCreated,
    cacheRate: cacheBase ? cacheRead / cacheBase : null,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreatedTokens: cacheCreated,
  };
};

export const runAnthropic = async ({ systemPrompt, messages }) => {
  if (!apiKey) throw new Error('ANTHROPIC_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.8,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Anthropic API response:', response.status, result?.error?.message || result);
      const error = new Error(result?.error?.message || `Anthropic API returned ${response.status}`);
      error.code = 'ANTHROPIC_REQUEST_FAILED';
      throw error;
    }
    const text = Array.isArray(result?.content)
      ? result.content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n').trim()
      : '';
    if (!text) throw new Error('ANTHROPIC_EMPTY_RESPONSE');
    return { text, metrics: metricsFromUsage(result.usage), model: result.model || model };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('ANTHROPIC_REQUEST_TIMED_OUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
