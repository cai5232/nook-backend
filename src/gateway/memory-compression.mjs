const cleanBase=value=>String(value||'').trim().replace(/\/+$/,'');
const contentText=content=>typeof content==='string'?content:Array.isArray(content)?content.map(p=>typeof p==='string'?p:(p?.text||'')).join('').trim():'';

export const normalizeMemoryModelConfig=input=>({
  url:cleanBase(input?.url),
  key:String(input?.key||'').trim(),
  model:String(input?.model||'').trim()
});

export const publicMemoryModelConfig=input=>{
  const c=normalizeMemoryModelConfig(input);
  return {url:c.url,model:c.model,configured:Boolean(c.url&&c.key&&c.model),hasKey:Boolean(c.key)};
};

export const runMemoryCompressionModel=async({config,systemPrompt,prompt})=>{
  const c=normalizeMemoryModelConfig(config);
  if(!c.url||!c.key||!c.model)throw new Error('MEMORY_COMPRESSION_NOT_CONFIGURED');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),90000);
  try{
    const response=await fetch(`${c.url}/chat/completions`,{
      method:'POST',
      headers:{authorization:`Bearer ${c.key}`,'content-type':'application/json'},
      body:JSON.stringify({model:c.model,messages:[{role:'system',content:systemPrompt},{role:'user',content:prompt}],temperature:.2,max_tokens:3500}),
      signal:controller.signal
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result?.error?.message||result?.message||`MEMORY_COMPRESSION_REQUEST_FAILED_${response.status}`);
    const text=contentText(result?.choices?.[0]?.message?.content);
    if(!text)throw new Error('MEMORY_COMPRESSION_EMPTY_RESPONSE');
    return {text,model:result?.model||c.model};
  }finally{clearTimeout(timeout)}
};
