import assert from 'node:assert/strict';
import test from 'node:test';

test('recalls and stores memory through Streamable HTTP MCP', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const payload = JSON.parse(options.body);
    if (payload.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-nocturne', version: '1.0.0' },
        },
      }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' } });
    }
    if (payload.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (payload.method === 'tools/call') {
      calls.push(payload.params);
      const text = payload.params.name === 'breath'
        ? '核心记忆'
        : payload.params.name === 'trace' ? '相关记忆' : '已保存';
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text }], isError: false },
      });
      return new Response(`event: message\ndata: ${body}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  process.env.NOCTURNE_MCP_URL = 'https://memory.example.test';
  const { recallMemory, storeMemory } = await import(`../nocturne-client.mjs?test=${Date.now()}`);

  const recalled = await recallMemory('一个月');
  assert.match(recalled, /核心记忆/);
  assert.match(recalled, /相关记忆/);
  await storeMemory({
    message: '我们在一起一个月了',
    reply: '我记得。',
    summary: '言言和沈屿在一起一个月。',
    importance: 8,
  });

  assert.deepEqual(calls.map((call) => call.name), ['breath', 'trace', 'hold']);
  assert.equal(calls.at(-1).arguments.importance, 8);
  assert.equal(calls.at(-1).arguments.kind, 'memory');
});
