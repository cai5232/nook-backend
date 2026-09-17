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
    if (ids.has(item?.id) && typeof item.description === 'string' && item.description.trim()) result[item.id] = item.description.trim().slice(0, 1600);
  }
  return result;
};

const separateThinkingFromReply = (replyValue, thinkingValue = '') => {
  let reply = String(replyValue || ''); const leaked = [];
  reply = reply.replace(/<(?:thinking|reasoning|analysis)\b[^>]*>([\s\S]*?)<\/(?:thinking|reasoning|analysis)>/gi, (_, body) => { const text=String(body||'').trim(); if(text) leaked.push(text); return ''; });
  reply = reply.replace(/<\/?(?:thinking|reasoning|analysis)\b[^>]*>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  const explicitThinking=String(thinkingValue||'').trim();
  return {reply,thinking:[explicitThinking,...leaked].filter(Boolean).filter((text,index,list)=>list.indexOf(text)===index).join('\n\n').trim()};
};

const finalizePayload = ({ reply, thinking = '', voiceText = '', imageDescriptions = {} }) => {
  const separated=separateThinkingFromReply(reply,thinking);
  return {reply:separated.reply,thinking:separated.thinking,voiceText:String(voiceText||'').trim().slice(0,5000),imageDescriptions};
};
const extractJsonObject=text=>{try{return JSON.parse(text)}catch{}const attempts=[];let depth=0,start=-1;for(let i=0;i<text.length;i++){if(text[i]==='{'){if(depth===0)start=i;depth++}else if(text[i]==='}'){depth--;if(depth===0&&start>=0){attempts.push(text.slice(start,i+1));start=-1}}}attempts.sort((a,b)=>b.length-a.length);for(const candidate of attempts){try{return JSON.parse(candidate)}catch{}}return null;};

export const parseModelPayload = (rawValue, attachments = []) => {
  const raw=String(rawValue||'').trim(),clean=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim(),parsed=extractJsonObject(clean);
  if(parsed&&(typeof parsed?.reply==='string'||typeof parsed?.voiceText==='string')){
    const result=finalizePayload({reply:typeof parsed.reply==='string'?parsed.reply.trim():'',thinking:typeof parsed.thinking==='string'?parsed.thinking.trim():'',voiceText:typeof parsed.voiceText==='string'?parsed.voiceText.trim():'',imageDescriptions:normalizeImageDescriptions(parsed.imageDescriptions,attachments)});
    if(result.reply||result.voiceText)return result;
  }
  const thinkingMatch=clean.match(/["']thinking["']\s*:\s*"([\s\S]*?)(?<!\\)",\s*["']reply["']/),replyMatch=clean.match(/["']reply["']\s*:\s*"([\s\S]*?)(?<!\\)"\s*(?:,|\})/),voiceMatch=clean.match(/["']voiceText["']\s*:\s*"([\s\S]*?)(?<!\\)"\s*(?:,|\})/);
  if(replyMatch||voiceMatch){const result=finalizePayload({reply:replyMatch?decodeLooseJsonString(replyMatch[1]).trim():'',thinking:thinkingMatch?decodeLooseJsonString(thinkingMatch[1]).trim():'',voiceText:voiceMatch?decodeLooseJsonString(voiceMatch[1]).trim():'',imageDescriptions:{}});if(result.reply||result.voiceText)return result;}
  if(/["'](?:thinking|reply|voiceText)["']\s*:/.test(clean))throw new Error('Model returned malformed structured output');
  return finalizePayload({reply:clean,thinking:'',voiceText:'',imageDescriptions:{}});
};
