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
// Manual compression is only a test action: always compress the latest 5 complete rounds,
// regardless of the automatic compression cursor, and never advance that cursor.
const manual=`if(url.pathname==='/api/memory/compress-now'){const body=await readJson(req),conversationId=resolveConversationId(body?.conversationId);if(!conversationId)return sendJson(res,400,{error:'Invalid conversation'},origin);if(!nocturneConfigured)return sendJson(res,503,{error:'Memory service not configured'},origin);const config=await loadMemoryModelConfig();if(!publicMemoryModelConfig(config).configured)return sendJson(res,503,{error:'Memory compression model not configured'},origin);const conversation=await loadConversation(conversationId),history=conversation.messages.filter(entry=>['user','assistant'].includes(entry.role));const complete=[];for(let i=0;i<history.length-1;i++){if(history[i]?.role==='user'&&history[i+1]?.role==='assistant'){complete.push(history[i],history[i+1]);i++}}const batch=complete.slice(-10);if(!batch.length)return sendJson(res,200,{ok:true,count:0,items:[],message:'还没有完整对话可压缩'},origin);const compressed=await compressMemoryBatch(batch);for(const item of compressed.items)await storeMemory({content:item,kind:'window',importance:6,tags:'nook,dialogue,manual-test,last-5-rounds'});conversation.memoryArchives.push({id:crypto.randomUUID(),start:null,end:null,count:batch.length,rounds:Math.floor(batch.length/2),items:compressed.items,model:compressed.model,manual:true,createdAt:Date.now(),afterMessageId:batch.at(-1)?.id||''});await saveConversation(conversation);return sendJson(res,200,{ok:true,count:compressed.items.length,rounds:Math.floor(batch.length/2),items:compressed.items,model:compressed.model,message:'近5轮记忆压缩完成'},origin)};`;
if(!source.includes(marker))throw new Error('Unable to install manual memory compression route');
source=source.replace(marker,manual+marker);
await writeFile(runtimePath,source,'utf8');
await import(pathToFileURL(runtimePath).href+`?v=${Date.now()}`);
