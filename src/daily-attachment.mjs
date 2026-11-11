import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, atomicWrite, chinaDate, datePath } from './runtime.mjs';

export function inlineDailyAssets(html, css, js) {
  const link = '<link rel="stylesheet" href="styles.css">';
  const script = '<script src="app.js" defer></script>';
  if (html.split(link).length !== 2 || html.split(script).length !== 2) throw new Error('日报资源结构不匹配，无法打包');
  if (/<\/style/i.test(css) || /<\/script/i.test(js)) throw new Error('内联资源包含不安全结束标记');
  return html.replace(link, () => `<style>${css}</style>`).replace(script, () => `<script>${js}</script>`);
}

export async function prepareDailyAttachment(root, now = new Date()) {
  const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
  const today = chinaDate(now);
  const date = Object.keys(state.published || {}).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today).sort().at(-1);
  if (!date) throw new Error('还没有成功发布的自动日报，请稍后再试');
  const record = state.published[date];
  if (!Number.isInteger(record.count) || record.count < 1) throw new Error('日报发布记录无效');
  // Derive the archive path, never trust an arbitrary path from state or a chat message.
  const folder = path.join(root, 'public/issues', datePath(date));
  const [html, css, js] = await Promise.all(['index.html', 'styles.css', 'app.js'].map(f => readFile(path.join(folder, f), 'utf8')));
  const filename = path.join(root, 'data/deliveries', `Insight-Daily-${date}.html`);
  await atomicWrite(filename, inlineDailyAssets(html, css, js));
  return { filename, date, count: record.count, description: `见微日报｜${date}｜${record.count}条\n${date === today ? '这是今天已发布的日报。' : '今天尚未发布，以下是最近一期日报。'}\n附件已包含样式和交互脚本，请下载后用浏览器打开；飞书内置预览可能不支持展开交互。内容由AI生成，未经人工逐条核验。` };
}
