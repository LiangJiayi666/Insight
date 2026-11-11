import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renderIssue } from '../scripts/render.mjs';
import { readJson, saveJson, atomicWrite, acquireLock, chinaDate, datePath, computeWindow, logEvent } from './runtime.mjs';
import { normalizeResults } from './providers.mjs';
import { selectionPrompt, writingPrompt, reviewPrompt, validateSelection, validateDraft, sourceRecord } from './editor.mjs';

export async function publish(root, issue) {
  const folder = path.join(root, 'public/issues', datePath(issue.date));
  const html = renderIssue(issue);
  for (const asset of ['styles.css', 'app.js']) {
    const text = await readFile(path.join(root, asset), 'utf8');
    await atomicWrite(path.join(folder, asset), text);
    await atomicWrite(path.join(root, 'public', asset), text);
  }
  await atomicWrite(path.join(folder, 'index.html'), html);
  await atomicWrite(path.join(root, 'public/index.html'), html);
}

export async function runDaily({ root, settings, sources, providerFactory, now = new Date() }) {
  const release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
  const date = chinaDate(now); const dp = datePath(date);
  const log = path.join(root, 'logs', dp.slice(0, 7), `${date}.jsonl`);
  const checkpointPath = path.join(root, 'data/runs', dp, 'checkpoint.json');
  const statePath = path.join(root, 'data/runtime/state.json');
  let checkpoint;
  try {
    const state = await readJson(statePath, { lastCutoff: null, published: {} });
    if (state.published[date]) { await logEvent(log, 'already-published'); return { status: 'already-published', date }; }
    checkpoint = await readJson(checkpointPath, null);
    const configHash = createHash('sha256').update(JSON.stringify({ settings, sources })).digest('hex');
    if (checkpoint && checkpoint.configHash !== configHash) throw new Error('本日任务配置已变动。请保留检查点，先恢复原配置完成运行，避免混合版本。');
    if (!checkpoint) checkpoint = { date, window: computeWindow(now, state.lastCutoff, settings), configHash, topics: {}, evidence: {}, drafts: {}, reviews: {}, rejections: {}, requests: { search: 0, model: 0 } };
    const persist = () => saveJson(checkpointPath, checkpoint);
    await persist();
    const provider = providerFactory(checkpoint, persist);
    await logEvent(log, 'started', { target: settings.targetStories });
    // Resume publication after a crash without regenerating content.
    const issuePath = path.join(root, 'data/issues', dp, 'issue.json');
    let issue = checkpoint.ready ? await readJson(issuePath) : null;
    if (!issue) {
      for (const [index, topic] of sources.topics.entries()) {
        if (checkpoint.topics[index]?.ok) continue;
        try {
          const raw = await provider.search(topic.query, checkpoint.window, topic.domains, settings.searchResultsPerTopic);
          const normalized = normalizeResults(raw, topic.category, checkpoint.window, settings.maxSourceCharacters);
          await saveJson(path.join(root, 'data/raw', dp, `topic-${index}.json`), { query: topic.query, window: checkpoint.window, results: normalized });
          checkpoint.topics[index] = { ok: true, items: normalized };
        } catch { checkpoint.topics[index] = { ok: false, items: [] }; await logEvent(log, 'source-failed', { topic: index }); }
        await persist();
      }
      const candidates = [...new Map(Object.values(checkpoint.topics).flatMap(t => t.items).map(s => [s.url, s])).values()].slice(0, settings.maxCandidates);
      if (!candidates.length) throw new Error('没有满足时间和正文要求的新闻，首页保持不变');
      if (!checkpoint.events) {
        const selection = await provider.json(selectionPrompt, { target: settings.targetStories, window: checkpoint.window,
          candidates: candidates.map(s => ({ ...s, text: s.text.slice(0, 1800) })) });
        checkpoint.events = validateSelection(selection, candidates, settings.targetStories); await persist();
      }
      const map = new Map(candidates.map(s => [s.id, s]));
      for (const [index, event] of checkpoint.events.entries()) {
        if (checkpoint.reviews[event.key]) continue;
        let evidence = checkpoint.evidence[event.key];
        if (!evidence) {
          evidence = event.sourceIds.map(id => map.get(id));
          if (event.backgroundQuery && index < settings.maxBackgroundQueries) {
            try {
              const window = { start: '2000-01-01T00:00:00Z', end: checkpoint.window.end };
              const background = normalizeResults(await provider.search(event.backgroundQuery, window, undefined, 3), '背景', window, settings.maxSourceCharacters);
              evidence = [...new Map([...evidence, ...background].map(s => [s.id, s])).values()];
            } catch { await logEvent(log, 'background-unavailable', { event: index }); }
          }
          checkpoint.evidence[event.key] = evidence;
          await saveJson(path.join(root, 'data/evidence', dp, `${event.key}.json`), evidence); await persist();
        }
        try {
          delete checkpoint.rejections[event.key];
          if (!checkpoint.drafts[event.key]) {
            const result = await provider.json(writingPrompt, { event, cutoff: checkpoint.window.end, evidence });
            checkpoint.drafts[event.key] = validateDraft(result.story, event, evidence, date, checkpoint.window.end); await persist();
          }
          const story = checkpoint.drafts[event.key];
          const review = await provider.json(reviewPrompt, { story, evidence, previousEvents: Object.entries(checkpoint.reviews).filter(([, r]) => r.approved).map(([key]) => checkpoint.drafts[key]) });
          if (typeof review.approved !== 'boolean' || !Array.isArray(review.reasons)) throw new Error('Invalid review');
          checkpoint.reviews[event.key] = review; await persist();
        } catch {
          // Do not store provider errors: they can contain sensitive responses.
          checkpoint.rejections[event.key] = '生成或审查未完成；该条不发布'; await persist();
          await logEvent(log, 'story-rejected', { event: index });
        }
      }
      const approved = checkpoint.events.filter(event => checkpoint.reviews[event.key]?.approved).map(event => checkpoint.drafts[event.key]);
      if (!approved.length) throw new Error('没有通过审查的新闻，首页保持不变');
      const records = new Map();
      for (const story of approved) {
        const used = new Set([...story.sourceIds, ...story.sections.flatMap(s => s.sourceIds || []), ...story.claims.map(c => c.sourceId)]);
        for (const item of checkpoint.evidence[story.id]) if (used.has(item.id)) records.set(item.id, sourceRecord(item));
        story.status = '自动生成 · 证据一致性审查通过，未经人工核验';
      }
      const failedTopics = Object.values(checkpoint.topics).filter(t => !t.ok).length;
      const categories = new Set(approved.map(s => s.category));
      const missingCategories = ['经济', '金融', '社会', '政治'].filter(c => !categories.has(c));
      issue = { date, cutoff: checkpoint.window.end, edition: '自动日报 / 12条目标',
        scope: `本期检索窗口 ${checkpoint.window.start} 至 ${checkpoint.window.end}；时间戳含时区。实际发布 ${approved.length}/${settings.targetStories} 条，不以旧闻补足。`,
        notice: `AI生成及模型证据一致性审查，不等于独立事实核验。${failedTopics} 个检索主题失败。${missingCategories.length ? `覆盖缺口：${missingCategories.join('、')}。` : ''}${checkpoint.window.gap ? '断更超过回补上限，更早区间未覆盖。' : ''}历史材料仅为背景。未启用飞书推送。`,
        banner: '自动新闻日报 · 请留意来源与不确定性', footer: '自动生成 / 引文匹配与模型审查 · 未经人工逐条核验',
        readingMinutes: Math.max(5, approved.length * 2), stories: approved, sources: [...records.values()] };
      renderIssue(issue); // Fail before writing a public artifact.
      await saveJson(issuePath, issue); checkpoint.ready = true; await persist();
    }
    await publish(root, issue);
    state.lastCutoff = checkpoint.window.end;
    state.published[date] = { count: issue.stories.length, path: `issues/${dp}/index.html`, cutoff: issue.cutoff };
    await saveJson(statePath, state);
    checkpoint.completed = true; await persist();
    await logEvent(log, 'published', { count: issue.stories.length });
    return { status: 'published', date, count: issue.stories.length, target: settings.targetStories };
  } catch (error) {
    await logEvent(log, 'failed', { checkpointAvailable: Boolean(checkpoint) }).catch(() => {});
    throw error;
  } finally { await release(); }
}
