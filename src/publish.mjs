import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { renderIssue } from './render.mjs';
import { atomicWrite, datePath } from './runtime.mjs';

export async function publish(root, issue, { latest = true } = {}) {
  const folder = path.join(root, 'public/issues', datePath(issue.date));
  const html = renderIssue(issue);
  for (const asset of ['styles.css', 'app.js']) {
    const text = await readFile(path.join(root, asset), 'utf8');
    await atomicWrite(path.join(folder, asset), text);
    if (latest) await atomicWrite(path.join(root, 'public', asset), text);
  }
  await atomicWrite(path.join(folder, 'index.html'), html);
  if (latest) await atomicWrite(path.join(root, 'public/index.html'), html);
}
