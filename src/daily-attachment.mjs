import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, atomicWrite, datePath } from './runtime.mjs';

export function inlineDailyAssets(html, css, js) {
  const link = '<link rel="stylesheet" href="styles.css">';
  const script = '<script src="app.js" defer></script>';
  if (html.split(link).length !== 2 || html.split(script).length !== 2) throw new Error('日报资源结构不匹配，无法打包');
  if (/<\/style/i.test(css) || /<\/script/i.test(js)) throw new Error('内联资源包含不安全结束标记');
  return html.replace(link, () => `<style>${css}</style>`).replace(script, () => `<script>${js}</script>`);
}

export async function prepareDailyAttachment(root, date) {
  const archivePath = datePath(date);
  const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
  const record = state.published[date];
  if (!record || !Number.isInteger(record.count) || record.count < 1) throw new Error('该刊期没有有效的日报发布记录');
  // Derive the archive path, never trust an arbitrary path from state or a chat message.
  const folder = path.join(root, 'public/issues', archivePath);
  const [html, css, js] = await Promise.all(['index.html', 'styles.css', 'app.js'].map(f => readFile(path.join(folder, f), 'utf8')));
  const filename = path.join(root, 'data/deliveries', `Insight-Daily-${date}.html`);
  await atomicWrite(filename, inlineDailyAssets(html, css, js));
  return { filename, date, count: record.count };
}
