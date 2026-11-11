import { fileURLToPath } from 'node:url';
import { syncGit } from '../src/git-sync.mjs';
try { console.log(await syncGit(fileURLToPath(new URL('../', import.meta.url)))); }
catch (e) { console.error(e.message); process.exitCode = 1; }
