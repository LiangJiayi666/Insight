import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function safeUrl(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('来源 URL 必须为无凭证的 HTTP(S) 链接');
  return escapeHtml(u.href);
}
export function validateIssue(issue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue.date) || !Number.isFinite(Date.parse(issue.cutoff))) throw new Error('无效刊期或截止时间');
  if (!issue.stories?.length || !issue.sources?.length) throw new Error('必须包含新闻和来源');
  const sources = new Set();
  for (const source of issue.sources) {
    if (!/^[a-z0-9-]+$/.test(source.id) || sources.has(source.id)) throw new Error('来源 ID 无效或重复');
    sources.add(source.id);
    safeUrl(source.url);
    for (const key of ['title', 'publisher', 'published', 'accessed', 'method', 'excerpt', 'limits']) if (!source[key]) throw new Error(`来源缺少 ${key}`);
  }
  const ids = new Set();
  for (const story of issue.stories) {
    if (!/^[a-z0-9-]+$/.test(story.id) || ids.has(story.id)) throw new Error('新闻 ID 无效或重复');
    ids.add(story.id);
    for (const key of ['title', 'facts', 'affected', 'takeaway', 'published', 'eventDate', 'status']) if (!story[key]) throw new Error(`新闻缺少 ${key}`);
    if (!story.sourceIds?.length || !story.sections?.length) throw new Error('新闻必须有出处和详情');
    if (!Number.isFinite(Date.parse(story.published))) throw new Error('新闻发布日期无效');
    if (Date.parse(story.published) > Date.parse(issue.cutoff)) throw new Error('新闻发布时间晚于截止时间');
    for (const section of story.sections) if (!section.title || !section.paragraphs?.length) throw new Error('详情不能为空');
    for (const id of [...story.sourceIds, ...story.sections.flatMap(s => s.sourceIds || [])]) if (!sources.has(id)) throw new Error(`不存在的来源 ${id}`);
  }
}
export function renderIssue(issue) {
  validateIssue(issue);
  const e = escapeHtml;
  const sourceMap = new Map(issue.sources.map(s => [s.id, s]));
  const citations = ids => ids?.length ? `<p class="small">依据：${ids.map(id => { const s = sourceMap.get(id); return `<a href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${e(s.publisher)} · ${e(s.published)} ↗</a>`; }).join('；')}</p>` : '';
  const stories = issue.stories.map((s, index) => {
    const allSources = [...new Set([...s.sourceIds, ...s.sections.flatMap(section => section.sourceIds || [])])];
    return `<details class="story" id="${e(s.id)}">
<summary><span class="story-number">${String(index + 1).padStart(2, '0')}</span><span class="story-heading"><span class="category">${e(s.category)} · ${e(s.published)}</span><span class="headline">${e(s.title)}</span></span><span class="toggle" aria-hidden="true"></span></summary>
<div class="story-body"><div class="quick-read"><h3>${e(s.takeaway)}</h3><p><strong>已报道事实：</strong>${e(s.facts)}</p><p><strong>跟谁有关：</strong>${e(s.affected)}</p><p class="small">事件／统计时间：${e(s.eventDate)} · 报道日期：${e(s.published)}</p>${citations(s.sourceIds)}</div>
${s.sections.map(section => `<details class="layer"><summary>${e(section.title)}<span>${e(section.tag)}</span></summary><div class="layer-body">${section.paragraphs.map(p => `<p>${e(p)}</p>`).join('')}${citations(section.sourceIds)}</div></details>`).join('\n')}
<details class="layer"><summary>原文、核验方式与信息边界<span>来源透明</span></summary><div class="layer-body">${allSources.map(id => { const source = sourceMap.get(id); return `<div class="example"><a href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer">${e(source.title)} ↗</a><p class="small">${e(source.publisher)} · ${e(source.kind)}<br>发布：${e(source.published)}<br>读取：${e(source.accessed)} · ${e(source.method)}</p><p><strong>核对摘录：</strong>${e(source.excerpt)}</p><p class="boundary">${e(source.limits)}</p></div>`; }).join('')}</div></details>
<a class="permalink" href="#${e(s.id)}">本条固定链接 ↗</a></div></details>`;
  }).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${e(issue.date)} · 见微日报</title><link rel="stylesheet" href="styles.css"></head>
<body><header class="masthead"><a class="brand" href="./" aria-label="见微首页"><span class="brand-mark">见</span><span>见微 <small>INSIGHT DAILY</small></span></a><span class="edition">${e(issue.date)}</span></header>
<main id="main">

<section class="brief" aria-labelledby="brief-title"><div class="section-bar"><h2 id="brief-title">本期新闻 <span>THE BRIEF</span></h2><button id="collapse-all" type="button" hidden>全部收起 ↥</button></div>${stories}</section>
<footer><span class="footer-brand">见微 <span>INSIGHT DAILY</span></span><details><summary>本期资料说明</summary><p>${e(issue.scope)}<br>${e(issue.notice)}</p></details><a href="#main">回到顶部 ↑</a></footer></main><script src="app.js" defer></script></body></html>\n`;
}

async function build() {
  const date = process.argv[2] || '2026-11-11';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('用法：npm run build -- YYYY-MM-DD');
  const root = new URL('../', import.meta.url);
  const issue = JSON.parse(await readFile(new URL(`data/issues/${date}.json`, root), 'utf8'));
  if (issue.date !== date) throw new Error('文件名和刊期不一致');
  const html = renderIssue(issue);
  const archive = new URL(`archive/${date}/`, root);
  await mkdir(archive, { recursive: true });
  await writeFile(new URL('index.html', archive), html);
  for (const asset of ['styles.css', 'app.js']) await copyFile(new URL(asset, root), new URL(asset, archive));
  await writeFile(new URL('index.html', root), html);
  console.log(`已生成 index.html 和 archive/${date}/index.html（${issue.stories.length} 条）`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) build().catch(error => { console.error(error.message); process.exitCode = 1; });
