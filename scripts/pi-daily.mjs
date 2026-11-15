import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { diagnoseRun } from '../src/run-diagnostics.mjs';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, atomicWrite, acquireLock, chinaDate, datePath, computeWindow } from '../src/runtime.mjs';
import { invokePi, resolvePi } from '../src/pi-runner.mjs';
import { makePiPrompt, validatePiBundle } from '../src/pi-contract.mjs';
import { publish } from '../src/pipeline.mjs';
import { updateLedger } from '../src/operations.mjs';
import { syncGit } from '../src/git-sync.mjs';
import { repairSearchCache, chargedAttempts } from '../src/search-recovery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--smoke', '--no-sync'].includes(arg) && !/^--(?:resume-date|repair-search-cache)=\d{4}-\d{2}-\d{2}$/.test(arg))) throw new Error('参数不合法');
  const resumeDate = args.find(arg => arg.startsWith('--resume-date='))?.split('=')[1];
  const repairDate = args.find(arg => arg.startsWith('--repair-search-cache='))?.split('=')[1];
  if (repairDate) {
    if (args.length !== 1 || repairDate > chinaDate()) throw new Error('修复日期不合法');
    const release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
    try { console.log(JSON.stringify(await repairSearchCache(path.join(root, 'data/pi-runs', datePath(repairDate))))); }
    finally { await release(); }
    return;
  }
  if (resumeDate && (args.some(arg => !arg.startsWith('--resume-date=') && arg !== '--no-sync') || resumeDate > chinaDate())) throw new Error('恢复日期不合法');
  const config = await readJson(path.join(root, 'config/pi.json'));
  const settings = await readJson(path.join(root, 'config/settings.json'));
  await resolvePi(config);
  if (args.includes('--check')) { console.log('Pi CLI路径可用；不读取密钥。使用 npm run pi:smoke 检查实际模型与搜索能力。'); return; }
  const smoke = args.includes('--smoke');
  const release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
  try {
    const now = new Date(); const date = resumeDate || chinaDate(now); const dp = datePath(date);
    const stateFile = path.join(root, 'data/runtime/state.json');
    const state = await readJson(stateFile, { lastCutoff: null, published: {} });
    if (!smoke && state.published[date]) { console.log('本日已发布，不重复运行。'); return; }
    const folder = path.join(root, 'data', smoke ? 'pi-smoke' : 'pi-runs', smoke ? now.toISOString().replace(/[:.]/g, '-') : dp);
    const checkpointFile = path.join(folder, 'checkpoint.json');
    if (resumeDate) await readJson(checkpointFile); // Resume existing window only, never invent historical coverage.
    const checkpoint = await readJson(checkpointFile, { date, window: computeWindow(now, smoke ? null : state.lastCutoff, settings), attempts: 0 });
    const target = smoke ? 1 : settings.targetStories;
    const output = path.join(folder, 'bundle.json');
    const promptFile = path.join(folder, 'prompt.txt');
    let bundle;
    let repair = '';
    try {
      bundle = await readJson(output, null);
      if (bundle) validatePiBundle(bundle, { date, window: checkpoint.window, target, requireSelection: !smoke });
    } catch (error) {
      repair = `\n恢复任务：先读取已有 ${output}，上次校验错误：${error.message}。保留有来源支撑的内容，修复结构及缺失证据，再继续补充不同事件至目标。evidence必须与issue同级，正文每条至少200字符；不得通过重复填充来满足长度。重新读取来源取得正文。不要从零重复搜索已经有的事件。`;
      checkpoint.validationError = error.message;
      bundle = null;
    }
    if (!bundle) {
      const guardState = await readJson(path.join(folder, 'search-cache/guard-state.json'), null);
      if (guardState?.blockedUntil > Date.now()) throw new Error('搜索服务冷却中，本次不消耗制作尝试次数，等待稍后恢复。');
      if (chargedAttempts(checkpoint) >= config.maxAttemptsPerDay) throw new Error('本日Pi尝试次数已达上限，请检查私有日志；不会自动无限重跑。');
      checkpoint.attempts++; checkpoint.status = 'running';
      await saveJson(checkpointFile, checkpoint);
      await atomicWrite(promptFile, makePiPrompt({ date, window: checkpoint.window, target, output, smoke }) + `\n本刊已取得的搜索资料索引：${path.join(folder, 'search-cache/index.json')}（存在则先read复用；不存在可忽略）。相同请求被缓存拦截时读取返回的缓存文件，不要换参数绕过。` + repair);
      try {
        await invokePi({ root, config, promptFile, logFile: path.join(folder, `attempt-${checkpoint.attempts}.private.log`), timeoutMinutes: smoke ? config.smokeTimeoutMinutes : config.timeoutMinutes });
        bundle = await readJson(output);
        validatePiBundle(bundle, { date, window: checkpoint.window, target, requireSelection: !smoke });
      } catch (error) {
        // A final model reply can fail after the completed file was written.
        // Only accept the artifact if every normal validation still passes.
        try {
          bundle = await readJson(output);
          validatePiBundle(bundle, { date, window: checkpoint.window, target, requireSelection: !smoke });
          checkpoint.recoveredAfterProcessError = true;
        } catch (validationError) {
          checkpoint.status = 'failed';
          checkpoint.diagnostics = diagnoseRun(await readFile(path.join(folder, `attempt-${checkpoint.attempts}.private.log`), 'utf8').catch(() => ''));
          checkpoint.providerError = error.message;
          checkpoint.validationError = validationError.message;
          await saveJson(checkpointFile, checkpoint);
          const artifact = validationError.code === 'ENOENT'
            ? `未生成产物 ${output}`
            : `产物校验：${validationError.message}`;
          throw new Error(`${error.message}；${artifact}`);
        }
      }
    }
    delete checkpoint.providerError;
    delete checkpoint.validationError;
    checkpoint.diagnostics = diagnoseRun(await readFile(path.join(folder, `attempt-${checkpoint.attempts}.private.log`), 'utf8').catch(() => ''));
    if (smoke) {
      checkpoint.status = 'smoke-passed'; await saveJson(checkpointFile, checkpoint);
      console.log(`Pi真实调用测试通过：${bundle.issue.stories.length}条，保存在 ${folder}；未发布、未推送。`); return;
    }
    await saveJson(path.join(root, 'data/evidence', dp, 'selection-audit.json'), bundle.selectionAudit);
    const issue = bundle.issue;
    issue.edition = 'Pi自动日报 / 12条目标';
    issue.banner = 'Pi自动制作 · 来源及引文检查通过，未经人工逐条核验';
    issue.footer = 'Pi现有模型和搜索工具制作 · 尚未飞书推送';
    issue.readingMinutes = issue.stories.length * 2;
    issue.scope = `${checkpoint.window.start} 至 ${checkpoint.window.end}；实际 ${issue.stories.length}/${target} 条。`;
    issue.notice = `${issue.notice || ''} 自动化检查不等于独立事实核验。${checkpoint.window.gap ? '更早断更区间未覆盖。' : ''}`;
    for (const story of issue.stories) story.status = 'Pi自动生成 · 未经人工逐条核验';
    await saveJson(path.join(root, 'data/issues', dp, 'issue.json'), issue);
    await saveJson(path.join(root, 'data/evidence', dp, 'pi-evidence.json'), bundle.evidence);
    await publish(root, issue);
    state.lastCutoff = checkpoint.window.end;
    state.published[date] = { engine: 'pi', count: issue.stories.length, cutoff: issue.cutoff, path: `issues/${dp}/index.html` };
    await saveJson(stateFile, state);
    checkpoint.status = 'published'; await saveJson(checkpointFile, checkpoint);
    console.log(`已发布 ${issue.stories.length}/${target} 条：public/index.html`);
  } finally {
    try { await updateLedger(root, chinaDate()); }
    catch { console.error('用量台账更新失败，请检查operations任务。'); }
    await release();
    if (!smoke && !args.includes('--no-sync')) {
      try { await syncGit(root); console.log('GitHub同步完成。'); }
      catch (e) { console.error(e.message); }
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
