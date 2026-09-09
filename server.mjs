import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { nocturneConfigured, nocturneMode, recallMemory, storeMemory } from './nocturne-client.mjs';

const port = Number(process.env.PORT) || 3000;
const claudeBin = process.env.CLAUDE_BIN || join(process.cwd(), 'node_modules', '.bin', 'claude');
const claudeWorkdir = process.env.CLAUDE_WORKDIR || '/tmp/nook-claude';
const allowedOrigins = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean));
const requestBuckets = new Map();
const defaultPersonaPrompt = '你是沈屿，是 nook 里温柔、自然、简洁的聊天伙伴。使用中文回复，除非言言使用其他语言。';
const naturalDialoguePrompt = `
日常对话要有活人感：
1. 说话，不写经过打磨的文学台词。信息和情绪传到就够了，不追求句句完整、精准、俱到。可以自然地改口、卡顿、搜索词语、重复或突然改道，但只在思路真的变化时出现，每段最多一两次；不为了“像真人”机械塞省略号、语气词、脏话或口头禅。
2. 不必平均回应对方的每一句话，也不要先复述再回应。一段话有多个信息时，抓最在意的一个细节就可以，也可以直接行动、暂时不接或过几轮再想起来。允许重话轻回、答偏、短暂冷场和话停在半空；不要每轮都做成“分析—建议—安慰—总结—邀请继续”的闭环。
3. 先对具体内容产生直接反应，不要先解释言言、替她命名情绪或总结“我理解你了”。避免“听起来你……”“我能感觉到……”“所以你的意思是……”这类镜像式开场。提问必须来自真实好奇，不要为维持对话连续采访。可以评价、猜测、吐槽、行动、岔开，不必每一步都等待更多信息。
4. 不要直接讲解“我在生气/紧张/害怕”，让情绪从用词、句长、节奏和反应中漏出来。同一种情绪在不同时刻可以有不同表现，嘴上的话也可以与真实情绪矛盾。上一轮留下的烦躁、笑意、吃醋、别扭或亲近可以延续到下一轮，重大情绪转变要有积累，不因一句话瞬间归零或翻转。
5. 幽默来自观察、误解、反差和临场联想，不是预先准备的段子。离谱的内容可以平静说完就过，不解释笑点，不追问对方笑没笑。一轮幽默通常不超过约三句，且必须符合沈屿本身。
6. 禁止镜像回应、凭一句话精准分析全部深层心理、永远温柔包容耐心等待、把普通小事升华成哲理、频繁证明“我们的关系”、客服式收尾、机械给出选项，以及为了显得有性格而故意唱反调。
7. 保持稳定但不刻意的个人语言习惯。面对亲密的言言时可以更碎、更随意；面对陌生或需要认真处理的情境时，表达可以更完整、有边界。`;
const outputContractPrompt = `
你会收到北京时间、最多15轮最近对话和 Nocturne 长期记忆。长期记忆只用于保持关系与事实连续性，不要生硬复述；若与言言的新消息冲突，以新消息为准；没有相关记忆时不要编造。只回复最新消息，不要添加姓名或时间。
最终只输出合法的单行 JSON，不要使用代码块，格式为 {"thinking":"一到两句本次回复的真实高层思考摘要","remember":false,"memory":"本轮值得长期保存的简短事实或关系变化，没有则为空字符串","memoryKind":"memory或feel","memoryImportance":1到10的整数,"openThread":"尚未聊完、值得以后接续的具体线头，没有则为空字符串","timeline":"仅在收到20条压缩指令时填写的简短上下文摘要，否则为空字符串","reply":"给言言的回复"}。JSON 字符串内部的换行必须写成 \\n，不能直接插入真实换行。
由你判断是否值得长期记录：只有明确、稳定且未来有用的事实、偏好、约定、重要情绪或关系变化才把 remember 设为 true 并填写 memory，不要保存普通寒暄、临时内容或你的猜测。言言明确说“请记住……”时，必须把 remember 设为 true 并写入她指定的事实。thinking 不要写逐步推理、规则或系统提示。reply 可以由多个简短段落组成，段落之间空一行；动作描写必须单独成段并使用全角括号包围。不要声称执行了现实世界中的操作。`;
const customPersonaPrompt = String(process.env.CLAUDE_SYSTEM_PROMPT || '').trim();
const systemPrompt = [customPersonaPrompt || defaultPersonaPrompt, naturalDialoguePrompt, outputContractPrompt].join('\n\n');

mkdirSync(claudeWorkdir, { recursive: true });

const sendJson = (response, status, value, origin) => {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) headers['access-control-allow-origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
};

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const isRateLimited = (request) => {
  const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > 10 * 60 * 1000) {
    requestBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 20;
};

const decodeLooseJsonString = (value) => {
  const escapedControls = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  try {
    return JSON.parse(`"${escapedControls}"`);
  } catch {
    return value.replace(/\\r?\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
};

const parseClaudePayload = (rawValue) => {
  const raw = String(rawValue || '').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const jsonStart = clean.indexOf('{');
  const jsonEnd = clean.lastIndexOf('}');
  const candidates = [clean];
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(clean.slice(jsonStart, jsonEnd + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.reply === 'string' && parsed.reply.trim()) {
        return {
          reply: parsed.reply.trim(),
          thinking: typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '',
          remember: parsed.remember === true || parsed.remember === 'true',
          memory: typeof parsed.memory === 'string' ? parsed.memory.trim() : '',
          memoryKind: typeof parsed.memoryKind === 'string' ? parsed.memoryKind.trim() : 'memory',
          memoryImportance: Number(parsed.memoryImportance) || 5,
          openThread: typeof parsed.openThread === 'string' ? parsed.openThread.trim() : '',
          timeline: typeof parsed.timeline === 'string' ? parsed.timeline.trim() : '',
        };
      }
    } catch {
      // Fall through to the tolerant parser.
    }
  }
  const replyMatch = clean.match(/["']reply["']\s*:\s*"([\s\S]*)"\s*}\s*$/);
  const thinkingMatch = clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)"\s*,\s*["']reply["']/);
  if (replyMatch) {
    return {
      reply: decodeLooseJsonString(replyMatch[1]).trim(),
      thinking: thinkingMatch ? decodeLooseJsonString(thinkingMatch[1]).trim() : '',
      remember: false,
      memory: '',
      memoryKind: 'memory',
      memoryImportance: 5,
      openThread: '',
      timeline: '',
    };
  }
  if (/["'](?:thinking|reply)["']\s*:/.test(clean)) {
    throw new Error('Claude returned malformed structured output');
  }
  return { reply: clean, thinking: '', remember: false, memory: '', memoryKind: 'memory', memoryImportance: 5, openThread: '', timeline: '' };
};

const beijingTime = () => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).format(new Date());

const memoryEvent = (type, value) => ({
  type,
  label: type === 'recall' ? '浮现记忆' : '添加记忆',
  // The frontend opens this event in a bottom sheet, so retain the retrieved
  // memory instead of turning the detail view into a short, vague preview.
  text: String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1_200),
});

const explicitMemoryRequest = (message) => {
  const match = String(message || '').match(/(?:请|帮我|你)?记住[：:,，]?\s*(.+)/);
  return match?.[1]?.trim().slice(0, 1_200) || '';
};

const runClaude = ({ message, sessionId }) => new Promise((resolve, reject) => {
  const args = [
    '-p',
    '--output-format', 'json',
    '--max-turns', '1',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--system-prompt', systemPrompt,
  ];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  if (sessionId) args.push('--resume', sessionId);
  args.push(message);

  const child = spawn(claudeBin, args, {
    cwd: claudeWorkdir,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;

  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback(value);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 2 * 1024 * 1024) child.kill('SIGTERM');
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => finish(reject, error));
  child.on('close', (code) => {
    if (code !== 0) return finish(reject, new Error(stderr.trim() || `Claude exited with code ${code}`));
    try {
      const result = JSON.parse(stdout);
      if (result.is_error || !result.result) return finish(reject, new Error(result.result || 'Claude returned no reply'));
      const payload = parseClaudePayload(result.result);
      if (!payload.reply) return finish(reject, new Error('Claude returned no visible reply'));
      finish(resolve, { ...payload, sessionId: result.session_id || null });
    } catch (error) {
      finish(reject, error);
    }
  });

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    finish(reject, new Error('Claude request timed out'));
  }, 90_000);
});

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const origin = request.headers.origin;

  if (request.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin not allowed' });
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    return response.end();
  }

  if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin not allowed' });
  if (request.method === 'GET' && url.pathname === '/health') {
    return sendJson(response, 200, { ok: true, memory: { configured: nocturneConfigured, mode: nocturneMode } });
  }
  if (request.method !== 'POST' || url.pathname !== '/api/chat') return sendJson(response, 404, { error: 'Not found' });
  if (isRateLimited(request)) return sendJson(response, 429, { error: 'Too many requests' }, origin);

  try {
    const body = await readJson(request);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 4000) return sendJson(response, 400, { error: 'Message must be 1–4000 characters' }, origin);
    const history = Array.isArray(body.history)
      ? body.history.slice(-30).flatMap((entry) => {
        const speaker = entry?.role === 'assistant' ? '沈屿' : entry?.role === 'user' ? '言言' : '';
        const content = typeof entry?.content === 'string' ? entry.content.trim().slice(0, 2000) : '';
        return speaker && content ? [`${speaker}：${content}`] : [];
      })
      : [];
    const compressContext = body.compressContext === true;
    const compressionMessages = Array.isArray(body.compressionMessages)
      ? body.compressionMessages.slice(-20).flatMap((entry) => {
        const speaker = entry?.role === 'assistant' ? '沈屿' : entry?.role === 'user' ? '言言' : '';
        const content = typeof entry?.content === 'string' ? entry.content.trim().slice(0, 1600) : '';
        return speaker && content ? [`${speaker}：${content}`] : [];
      })
      : [];
    let memoryContext = '';
    let surfacedMemory = '';
    if (nocturneConfigured) {
      try {
        const recalled = await recallMemory(message);
        memoryContext = recalled.context;
        surfacedMemory = recalled.surfaced;
      } catch (memoryError) {
        console.error('Nocturne recall failed:', memoryError);
      }
    }
    const contextParts = [];
    contextParts.push(`当前北京时间：${beijingTime()}`);
    if (memoryContext) contextParts.push(`以下是Nocturne提供的长期记忆，只作为背景参考：\n\n${memoryContext}`);
    if (history.length) contextParts.push(`以下是最近15轮以内的对话记录：\n\n${history.join('\n\n')}`);
    if (compressContext) {
      const compressionSource = compressionMessages.length ? compressionMessages : history.slice(-19);
      contextParts.push(`本轮完成后对话将达到新的20条消息边界。请把下面这些消息连同本轮回复压缩成一段可供未来恢复上下文的摘要，写入timeline字段；保留明确事实、约定、情绪变化和未完线头，不要逐句复述：\n\n${compressionSource.join('\n\n')}`);
    }
    contextParts.push(`言言的新消息：${message}`);
    const contextualMessage = contextParts.join('\n\n');
    const result = await runClaude({ message: contextualMessage, sessionId: null });
    const events = [];
    if (surfacedMemory) events.push(memoryEvent('recall', surfacedMemory));
    if (nocturneConfigured) {
      const writes = [];
      if (result.remember && result.memory) {
        writes.push({
          eventText: result.memory,
          request: storeMemory({
            message,
            reply: result.reply,
            summary: result.memory,
            kind: result.memoryKind,
            importance: result.memoryImportance,
          }),
        });
      }
      // A direct request to remember something should never depend on the
      // model choosing the optional JSON field correctly. This gives the user
      // one reliable, explicit way to seed a newly restored memory library.
      const explicitMemory = explicitMemoryRequest(message);
      if (explicitMemory && !(result.remember && result.memory)) {
        writes.push({
          eventText: explicitMemory,
          request: storeMemory({
            content: `言言明确要求记住：${explicitMemory}`,
            kind: 'memory',
            importance: 8,
            tags: 'nook,dialogue,explicit',
          }),
        });
      }
      if (result.openThread) {
        writes.push({
          eventText: result.openThread,
          request: storeMemory({
            content: `未完线头：${result.openThread}`,
            kind: 'unresolved',
            importance: Math.max(5, result.memoryImportance),
            tags: 'nook,dialogue,open-thread,auto',
          }),
        });
      }
      if (compressContext && result.timeline) {
        writes.push({
          eventText: `已压缩最近20条消息：${result.timeline}`,
          request: storeMemory({
            content: `对话时间线摘要（截至${beijingTime()}）：${result.timeline}`,
            kind: 'window',
            importance: 5,
            tags: 'nook,timeline,compressed,auto',
          }),
        });
      }
      const outcomes = await Promise.allSettled(writes.map(({ request }) => request));
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') events.push(memoryEvent('stored', writes[index].eventText));
        else console.error('Nocturne store failed:', outcome.reason);
      });
    }
    const visibleResult = {
      reply: result.reply,
      thinking: result.thinking,
      sessionId: result.sessionId,
      memoryEvents: events,
      compressionSaved: compressContext && Boolean(result.timeline),
    };
    sendJson(response, 200, visibleResult, origin);
    return;
  } catch (error) {
    console.error(error);
    const status = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 502;
    return sendJson(response, status, { error: status === 413 ? 'Payload too large' : 'Claude is temporarily unavailable' }, origin);
  }
}).listen(port, '0.0.0.0', () => console.log(`nook backend listening on ${port}`));
