import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSourceAccessTimes, alignSourceAccessTimes } from '../src/source-access.mjs';
const url = 'https://example.com/news';
function fetchLog(at, error = false) {
  return [JSON.stringify({type:'tool_execution_start',toolName:'mcp__exa__web_fetch_exa',toolCallId:'call',args:{urls:[url]}}),JSON.stringify({type:'message_end',message:{role:'toolResult',toolName:'mcp__exa__web_fetch_exa',toolCallId:'call',timestamp:Date.parse(at),isError:error,content:[]}})].join('\n');
}
test('source access uses latest successful tool timestamp and ignores failures and unstructured content', () => {
  const times = collectSourceAccessTimes(fetchLog('2026-11-23T16:55:00Z'));
  collectSourceAccessTimes(fetchLog('2026-11-24T00:00:00Z', true), times);
  collectSourceAccessTimes(fetchLog('2026-11-21T00:00:00Z'), times);
  collectSourceAccessTimes('accessed 2026-11-30\n' + JSON.stringify({type:'message_end',message:{role:'assistant',timestamp:Date.parse('2026-11-30')}}), times);
  assert.equal(times.get(url), '2026-11-23T16:55:00.000Z');
});
test('historical publication corrects access metadata while preserving publication dates and text', async t => {
  const folder=await mkdtemp(path.join(os.tmpdir(),'insight-access-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  await writeFile(path.join(folder,'attempt-4.private.log'),fetchLog('2026-11-23T16:55:00Z'));
  const issue={sources:[{id:'s-1',url,accessed:'2026-11-20',published:'2026-11-20',excerpt:'original'},{id:'s-2',url:'https://example.com/other',accessed:'2026-11-21'}]};
  const corrections=await alignSourceAccessTimes(issue,folder);
  assert.equal(corrections.length,1);
  assert.equal(issue.sources[0].accessed,'2026-11-23T16:55:00.000Z');
  assert.equal(issue.sources[0].published,'2026-11-20');
  assert.equal(issue.sources[0].excerpt,'original');
  assert.equal(issue.sources[1].accessed,'2026-11-21');
});
