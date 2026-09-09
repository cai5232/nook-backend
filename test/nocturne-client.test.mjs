import assert from 'node:assert/strict';
import test from 'node:test';

test('recalls and stores memory through the direct Nocturne HTTP API', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body, headers: options.headers });
    if (String(url).endsWith('/api/integrations/nook/recall')) {
      return Response.json({ core: '核心记忆', memories: [{ content: '喜欢珍珠奶茶' }], surfaced: '喜欢珍珠奶茶' });
    }
    if (String(url).endsWith('/api/integrations/nook/memories')) {
      return Response.json({ ok: true, id: 'memory-1' });
    }
    return new Response('not found', { status: 404 });
  };

  process.env.NOCTURNE_API_URL = 'https://memory.example.test/mcp';
  process.env.NOCTURNE_API_TOKEN = 'secret';
  const { nocturneMode, recallMemory, storeMemory } = await import(`../nocturne-client.mjs?test=${Date.now()}`);

  assert.equal(nocturneMode, 'direct-http');
  const recalled = await recallMemory('我喜欢喝什么？');
  assert.match(recalled.context, /核心记忆/);
  assert.match(recalled.context, /喜欢珍珠奶茶/);
  assert.equal(recalled.surfaced, '喜欢珍珠奶茶');
  await storeMemory({
    message: '我喜欢珍珠奶茶',
    reply: '记住了。',
    summary: '言言喜欢珍珠奶茶。',
    importance: 8,
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/api/integrations/nook/recall',
    '/api/integrations/nook/memories',
  ]);
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.equal(calls[1].body.importance, 8);
  assert.equal(calls[1].body.kind, 'memory');
});

test('does not create a memory when the model chose nothing to keep', async () => {
  process.env.NOCTURNE_API_URL = 'https://memory.example.test';
  const { storeMemory } = await import(`../nocturne-client.mjs?empty=${Date.now()}`);
  const result = await storeMemory({ message: '你好', reply: '你好呀', summary: '' });
  assert.equal(result, '');
});
