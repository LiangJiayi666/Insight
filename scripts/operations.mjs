import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { updateLedger, deliverDailyReport, maintain } from '../src/operations.mjs';
import { syncGit } from '../src/git-sync.mjs';
import { acquireLock, chinaDate } from '../src/runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let release;
try {
  release = await acquireLock(path.join(root, 'data/runtime/operations.lock'));
  let notificationError;
  // A missed scheduled run must not send yesterday's job as today's report before 22:00.
  const chinaHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (process.argv.includes('--notify') && chinaHour >= 22) {
    try { console.log('daily-report:', await deliverDailyReport(root)); }
    catch (e) { notificationError = e; }
  } else await updateLedger(root, chinaDate());
  console.log(JSON.stringify(await maintain(root)));
  try { console.log('github:', (await syncGit(root)).status); }
  catch (e) { console.error(e.message); }
  if (notificationError) throw notificationError;
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await release?.(); }
