import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { updateLedger, deliverDailyReport, maintain } from '../src/operations.mjs';
import { syncGit } from '../src/git-sync.mjs';
import { acquireLock, chinaDate } from '../src/runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let release;
try {
  release = await acquireLock(path.join(root, 'data/runtime/operations.lock'));
  const ledger = await updateLedger(root, chinaDate());
  let notificationError;
  if (process.argv.includes('--notify')) {
    try { console.log('daily-report:', await deliverDailyReport(root)); }
    catch (e) { notificationError = e; }
  }
  console.log(JSON.stringify(await maintain(root)));
  try { console.log('github:', (await syncGit(root)).status); }
  catch (e) { console.error(e.message); }
  if (notificationError) throw notificationError;
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await release?.(); }
