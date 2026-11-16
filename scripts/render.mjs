import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson, datePath, acquireLock } from '../src/runtime.mjs';
import { publish } from '../src/publish.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function issueDates() {
  const base = path.join(root, 'data/issues');
  const dates = [];
  const directories = async (folder, pattern) => (await readdir(folder, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name);
  for (const year of await directories(base, /^\d{4}$/)) {
    for (const month of await directories(path.join(base, year), /^\d{2}$/)) {
      for (const day of await directories(path.join(base, year, month), /^\d{2}$/)) {
        const date = `${year}-${month}-${day}`;
        if (await readJson(path.join(base, datePath(date), 'issue.json'), null)) dates.push(date);
      }
    }
  }
  return dates.sort();
}

let release;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !/^\d{4}-\d{2}-\d{2}$/.test(args[0]))) throw new Error('用法：npm run build -- [YYYY-MM-DD]');
  release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
  const dates = await issueDates();
  const date = args[0] || dates.at(-1);
  if (!dates.includes(date)) throw new Error('没有对应的结构化日报，请先运行 daily:pi');
  const issue = await readJson(path.join(root, 'data/issues', datePath(date), 'issue.json'));
  if (issue.date !== date) throw new Error('文件路径和刊期不一致');
  await publish(root, issue, { latest: date === dates.at(-1) });
  console.log(`已从现有稿件重建 ${date}（${issue.stories.length}条），未调用模型或搜索。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await release?.(); }
