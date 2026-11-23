import { fileURLToPath } from 'node:url';
import { inspectHealth } from '../src/health.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const report = await inspectHealth(root);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'healthy') process.exitCode = 1;
} catch (error) { console.error('诊断失败：' + error.message); process.exitCode = 1; }
