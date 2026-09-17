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
// Manual compression is a test action: use the latest 5 complete rounds and save exactly ONE memory.
// It is independent from automatic 20-round compression and never advances the auto cursor.
const manual=`if(url.pathname==='/api/memory/compress-now'){const body=await readJson(req),conversationId=resolveConversationId(body?.conversationId);if(!conversationId)return sendJson(res,400,{error:'Invalid conversation'},origin);if(!nocturneConfigured)return sendJson(res,503,{error:'Memory service not configured'},origin);const config=await loadMemoryModelConfig();if(!publicMemoryModelConfig(config).configured)return sendJson(res,503,{error:'Memory compression model not configured'},origin);const conversation=await loadConversation(conversationId),history=conversation.messages.filter(entry=>['user','assistant'].includes(entry.role));const complete=[];for(let i=0;i<history.length-1;i++){if(history[i]?.role==='user'&&history[i+1]?.role==='assistant'){complete.push(history[i],history[i+1]);i++}}const batch=complete.slice(-10);if(!batch.length)return sendJson(res,200,{ok:true,count:0,items:[],message:'还没有完整对话可压缩'},origin);const transcript=batch.map((entry,index)=>\`${'${index+1}'}. ${'${entry.role===\'user\'?\'言言\':\'沈屿\'}'}：${'${memoryTextForEntry(entry)||\'[无文字内容]\'}'}\`).join('\\n'),prompt=\`下面是最近 ${'${Math.floor(batch.length/2)}'} 轮对话。请把其中真正值得长期保留的信息压缩成一条简洁、完整、可检索的长期记忆。只保留重要事实、偏好、决定、关系变化、情绪事件、项目进展或重要结论；合并重复，不添加原文没有的信息。不要列多条，不要编号。严格输出 JSON：{"memories":["唯一的一条记忆"]}。\\n\\n${'${transcript}'}\`,result=await runMemoryCompressionModel({config,systemPrompt:'你是 Nook 独立的长期记忆压缩器。手动测试时必须把最近对话合并成且只输出一条长期记忆。',prompt}),parsed=parseMemoryItems(result.text),item=parsed.filter(Boolean).join('；').trim();if(!item)throw new Error('EMPTY_MEMORY_SUMMARY');await storeMemory({content:item,kind:'window',importance:6,tags:'nook,dialogue,manual-test,last-5-rounds,single'});conversation.memoryArchives.push({id:crypto.randomUUID(),start:null,end:null,count:batch.length,rounds:Math.floor(batch.length/2),items:[item],model:result.model,manual:true,createdAt:Date.now(),afterMessageId:batch.at(-1)?.id||''});await saveConversation(conversation);return sendJson(res,200,{ok:true,count:1,rounds:Math.floor(batch.length/2),items:[item],model:result.model,message:'近5轮已压缩为1条记忆'},origin)};`;
if(!source.includes(marker))throw new Error('Unable to install manual memory compression route');
source=source.replace(marker,manual+marker);
await writeFile(runtimePath,source,'utf8');
await import(pathToFileURL(runtimePath).href+`?v=${Date.now()}`);
