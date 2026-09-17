import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const sourcePath=join(here,'server.mjs');
const runtimePath=join(here,'.server-runtime.mjs');
let source=await readFile(sourcePath,'utf8');

// One round = one user message + one assistant reply. Auto compression runs every 20 rounds = 40 messages.
source=source.replace('contextWindowMessages=20,memoryBatchMessages=20','contextWindowMessages=20,memoryBatchMessages=40');
source=source.replaceAll('compressed-20,auto','compressed-20-rounds,auto');

const marker="if(['/api/uploads','/api/upload','/api/images'].includes(url.pathname))";
const manual=`if(url.pathname==='/api/memory/compress-now'){const body=await readJson(req),conversationId=resolveConversationId(body?.conversationId);if(!conversationId)return sendJson(res,400,{error:'Invalid conversation'},origin);if(!nocturneConfigured)return sendJson(res,503,{error:'Memory service not configured'},origin);const config=await loadMemoryModelConfig();if(!publicMemoryModelConfig(config).configured)return sendJson(res,503,{error:'Memory compression model not configured'},origin);const conversation=await loadConversation(conversationId),history=conversation.messages.filter(entry=>['user','assistant'].includes(entry.role)),cursor=Math.max(0,Number(conversation.memoryCompressedUpTo)||0),batch=history.slice(cursor);if(!batch.length)return sendJson(res,200,{ok:true,count:0,items:[],message:'没有待压缩的新对话'},origin);const compressed=await compressMemoryBatch(batch);for(const item of compressed.items)await storeMemory({content:item,kind:'window',importance:6,tags:'nook,dialogue,manual-test'});conversation.memoryArchives.push({id:crypto.randomUUID(),start:cursor+1,end:history.length,count:batch.length,items:compressed.items,model:compressed.model,manual:true,createdAt:Date.now(),afterMessageId:batch.at(-1)?.id||''});conversation.memoryCompressedUpTo=history.length;await saveConversation(conversation);return sendJson(res,200,{ok:true,count:compressed.items.length,items:compressed.items,model:compressed.model,message:'记忆压缩完成'},origin)};`;
if(!source.includes(marker))throw new Error('Unable to install manual memory compression route');
source=source.replace(marker,manual+marker);
await writeFile(runtimePath,source,'utf8');
await import(pathToFileURL(runtimePath).href+`?v=${Date.now()}`);
