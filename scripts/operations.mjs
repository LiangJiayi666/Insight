import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { updateLedger, deliverDailyReport, maintain } from '../src/operations.mjs';
import { syncGit } from '../src/git-sync.mjs';
import { acquireLock, chinaDate, saveJson } from '../src/runtime.mjs';
import { inspectHealth } from '../src/health.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let release;
try {
  release = await acquireLock(path.join(root, 'data/runtime/operations.lock'));
  let notificationError;
  // A missed scheduled run must not send today's evening report before 21:00.
  const chinaTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (process.argv.includes('--notify') && chinaTime >= '21:00') {
    try { console.log('daily-report:', await deliverDailyReport(root)); }
    catch (e) { notificationError = e; }
  } else await updateLedger(root, chinaDate());
  console.log(JSON.stringify(await maintain(root)));
  try { console.log('github:', (await syncGit(root)).status); }
  catch (e) { console.error(e.message); }
  const health = await inspectHealth(root);
  await saveJson(path.join(root, 'data/runtime/health.json'), health);
  if (health.status !== 'healthy') {
    console.error('项目健康检查未通过：' + health.findings.map(f => f.message).join('；'));
    process.exitCode = 1;
  }
  if (notificationError) throw notificationError;
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await release?.(); }
