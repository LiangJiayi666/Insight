import { fileURLToPath } from 'node:url';
import { redeliverDailyReports } from '../src/operations.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
try { console.log(JSON.stringify(await redeliverDailyReports(root, process.argv.slice(2)), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
