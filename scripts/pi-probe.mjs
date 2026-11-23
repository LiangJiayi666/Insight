import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { atomicWrite, readJson, saveJson } from '../src/runtime.mjs';
import { invokePi } from '../src/pi-runner.mjs';
import { checkPiMcp } from '../src/pi-preflight.mjs';
import { updateLedger } from '../src/operations.mjs';
import { chinaDate } from '../src/runtime.mjs';

// A short, non-publishing probe using the same Pi entry, authentication and MCP.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !arg.startsWith('--model=')) || args.length > 1) throw new Error('仅支持 --model=provider/model');
const config = await readJson(path.join(root, 'config/pi.json'));
if (args[0]) config.model = args[0].slice('--model='.length);
const now = new Date();
const folder = path.join(root, 'data/pi-smoke', now.toISOString().replace(/[:.]/g, '-'));
const result = { at: now.toISOString(), model: config.model, status: 'running' };
try {
  result.mcp = await checkPiMcp(config, root);
  const promptFile = path.join(folder, 'prompt.txt');
  await atomicWrite(promptFile, 'Connectivity check only. Reply with the single word OK. Do not call tools, read files, write files, or perform any other task.');
  await invokePi({ root, config: { ...config, tools: [] }, promptFile, logFile: path.join(folder, 'attempt-1.private.log'), timeoutMinutes: 2 });
  const events = (await readFile(path.join(folder, 'attempt-1.private.log'), 'utf8')).split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const reply = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
  const text = (reply?.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (reply?.stopReason !== 'stop' || text !== 'OK' || events.some(e => e.type === 'tool_execution_start')) throw new Error('模型未按预期返回OK，连接探测未通过');
  result.actualModel = `${reply.provider}/${reply.model}`;
  result.requestedThinkingLevel = config.thinkingLevel || null;
  result.actualThinkingLevel = reply.thinkingLevel || null;
  result.status = 'passed';
  console.log('Pi模型响应与Exa工具发现通过：' + result.actualModel + (result.actualThinkingLevel ? '，思考强度 ' + result.actualThinkingLevel : '') + '（未验证真实搜索、读取或写稿）');
} catch (error) {
  result.status = 'failed'; result.error = error.message;
  console.error(error.message); process.exitCode = 1;
} finally {
  await saveJson(path.join(folder, 'probe.json'), result);
  await updateLedger(root, chinaDate(now));
}
