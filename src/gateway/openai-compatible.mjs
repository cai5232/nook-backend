import { createHash } from 'node:crypto';

const apiKey=String(process.env.AI_API_KEY||'').trim();
export const aiBaseUrl=String(process.env.AI_BASE_URL||'').trim().replace(/\/+$/,'');
export const aiModel=String(process.env.AI_MODEL||'').trim();
export const aiConfigured=Boolean(apiKey&&aiBaseUrl&&aiModel);
const num=v=>Number.isFinite(Number(v))?Number(v):null;

const metricsFromUsage=(usage={})=>{
  const prompt=num(usage.prompt_tokens??usage.input_tokens)??0;
  const output=num(usage.completion_tokens??usage.output_tokens)??0;
  const anthropicRead=num(usage.cache_read_input_tokens??usage.input_cache_read??usage.cache_read??usage.cacheReadInputTokens);
  const openAiRead=num(usage?.prompt_tokens_details?.cached_tokens);
  const cacheRead=anthropicRead??openAiRead??0;
  const explicitWrite=num(usage.cache_creation_input_tokens??usage.cache_creation_tokens??usage.input_cache_write??usage.cache_write??usage.cacheCreatedInputTokens);
  const timedWrite=(num(usage.input_cache_write_5_min)??0)+(num(usage.input_cache_write_1_h)??0);
  const cacheWrite=explicitWrite??timedWrite;
  const logical=prompt+cacheRead+cacheWrite;
  const providerRate=num(usage.cache_hit_rate??usage.cacheHitRate);
  const normalizedProvider=providerRate==null?null:(providerRate>1?providerRate/100:providerRate);
  const computed=logical>0?cacheRead/logical:null;
  const rate=normalizedProvider??computed;
  return {tokens:num(usage.total_tokens)??logical+output,inputTokens:logical,uncachedInputTokens:prompt,outputTokens:output,cacheReadTokens:cacheRead,cacheCreatedTokens:cacheWrite,cacheRate:rate==null?null:Math.max(0,Math.min(1,rate))};
};

const contentText=content=>typeof content==='string'?content:Array.isArray(content)?content.map(p=>typeof p==='string'?p:(p?.text||'')).join('').trim():'';
const hash=v=>createHash('sha256').update(String(v??'')).digest('hex').slice(0,16);
const cacheEnabled=()=>{const v=String(process.env.AI_PROMPT_CACHE||'').trim().toLowerCase();if(['0','false','off','no'].includes(v))return false;if(['1','true','on','yes'].includes(v))return true;return /(^|\/)claude(?:-|$)/i.test(aiModel)||/anthropic/i.test(aiModel);};
const cacheBlock=content=>{const blocks=Array.isArray(content)?content.map(p=>typeof p==='string'?{type:'text',text:p}:{...p}):[{type:'text',text:String(content??'')}];if(blocks.length)blocks[blocks.length-1]={...blocks[blocks.length-1],cache_control:{type:'ephemeral'}};return blocks;};
const cachedSystemContent=p=>cacheEnabled()?cacheBlock(p):p;

// Keep the message cache boundary stable instead of moving it on every turn.
// A moving breakpoint changes the cache prefix and can force providers/proxies
// to create a fresh cache rather than reuse the previous one.
const stableBreakpointIndex=messages=>{
  if(!Array.isArray(messages)||messages.length<3)return null;
  const stableCount=messages.length-1; // current user input is volatile
  const configured=Math.max(2,Number(process.env.AI_CACHE_STABLE_MESSAGES)||8);
  return stableCount>=configured?configured-1:null;
};
const withStableCacheBreakpoint=messages=>{
  if(!cacheEnabled()||!Array.isArray(messages))return messages;
  const copy=messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.map(p=>typeof p==='object'&&p?{...p}:p):m.content}));
  const index=stableBreakpointIndex(copy);
  if(index!=null){const target=copy[index];if(target&&['user','assistant'].includes(target.role))target.content=cacheBlock(target.content);}
  return copy;
};

const diagnostics=(systemPrompt,messages)=>{const stable=Array.isArray(messages)&&messages.length>1?messages.slice(0,-1):[],text=stable.map(m=>`${m.role}:${contentText(m.content)}`).join('\n');return{systemHash:hash(systemPrompt),systemChars:String(systemPrompt??'').length,historyHash:hash(text),historyChars:text.length,stableMessages:stable.length,bp4Index:stableBreakpointIndex(messages)};};

export const runModel=async({systemPrompt,messages})=>{
  if(!aiConfigured)throw new Error('AI_NOT_CONFIGURED');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Number(process.env.AI_TIMEOUT_MS)||120000);
  const diag=diagnostics(systemPrompt,messages);
  const requestMessages=[{role:'system',content:cachedSystemContent(systemPrompt)},...withStableCacheBreakpoint(messages)];
  console.log('[prompt-cache request]',JSON.stringify({model:aiModel,cacheEnabled:cacheEnabled(),...diag}));
  try{
    const response=await fetch(`${aiBaseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({model:aiModel,messages:requestMessages,temperature:Number(process.env.AI_TEMPERATURE??.8),max_tokens:Number(process.env.AI_MAX_TOKENS)||1800}),signal:controller.signal});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result?.error?.message||result?.message||`AI_REQUEST_FAILED_${response.status}`);
    const text=contentText(result?.choices?.[0]?.message?.content);
    if(!text)throw new Error('AI_EMPTY_RESPONSE');
    const usage=result?.usage||{};
    const metrics=metricsFromUsage(usage);
    console.log('[prompt-cache usage]',JSON.stringify({prompt:metrics.uncachedInputTokens,cache_read:metrics.cacheReadTokens,cache_write:metrics.cacheCreatedTokens,cache_hit_rate:metrics.cacheRate==null?null:Number((metrics.cacheRate*100).toFixed(2)),raw_usage:usage,...diag}));
    return{text,model:result?.model||aiModel,metrics};
  }finally{clearTimeout(timeout);}
};
