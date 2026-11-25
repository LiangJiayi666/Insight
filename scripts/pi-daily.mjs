import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { diagnoseRun } from '../src/run-diagnostics.mjs';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, atomicWrite, acquireLock, chinaDate, datePath, computeWindow } from '../src/runtime.mjs';
import { invokePi, resolvePi } from '../src/pi-runner.mjs';
import { makePiPrompt, validatePiBundle } from '../src/pi-contract.mjs';
import { publish } from '../src/publish.mjs';
import { updateLedger, filesUnder } from '../src/operations.mjs';
import { pendingIssueDates, issueWindow, publicationPosition, shiftDate } from '../src/daily-plan.mjs';
import { syncGit } from '../src/git-sync.mjs';
import { initializeSearchBudget, budgetSummary } from '../src/search-budget.mjs';
import { checkPiMcp } from '../src/pi-preflight.mjs';
import { alignSourceAccessTimes } from '../src/source-access.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function produceIssue({ date, now, state, config, settings, smoke, resumeDate, retryFailed, preflight }) {
  const dp = datePath(date);
  const stateFile = path.join(root, 'data/runtime/state.json');
  if (!smoke && state.published[date]) { console.log(date + '已发布，不重复运行。'); return; }
  const folder = path.join(root, 'data', smoke ? 'pi-smoke' : 'pi-runs', smoke ? now.toISOString().replace(/[:.]/g, '-') : dp);
  const checkpointFile = path.join(folder, 'checkpoint.json');
  if (resumeDate) await readJson(checkpointFile); // Resume existing window only, never invent historical coverage.
  const previousCheckpoint = smoke ? null : await readJson(path.join(root, 'data/pi-runs', datePath(shiftDate(date, -1)), 'checkpoint.json'), null);
  const checkpoint = await readJson(checkpointFile, null) || { date, window: smoke ? computeWindow(now, null, settings) : issueWindow(date, state, settings, now, previousCheckpoint), attempts: 0 };
  if (checkpoint.date !== date) throw new Error('检查点刊期不匹配');
  const target = smoke ? 1 : settings.targetStories;
  const backfill = !smoke && date < chinaDate(now);
  const output = path.join(folder, 'bundle.json');
  const promptFile = path.join(folder, 'prompt.txt');
  const validation = { date, window: checkpoint.window, target, requireSelection: !smoke, requireHistory: !smoke };
  await saveJson(path.join(folder, 'validation.json'), validation);
  let bundle;
  let repair = '';
  try {
    bundle = await readJson(output, null);
    if (bundle) validatePiBundle(bundle, validation);
  } catch (error) {
    repair = `\n恢复任务：先读取已有 ${output}，上次校验错误：${error.message}。使用insight_update_bundle按JSON字段修改；先用空operations取得revision再read文件，每次只修改必要字段，避免重新输出整份JSON导致连接中断。保留有来源支撑的内容，优先补齐历史序列、比较及缺失证据，质量达标后才考虑增加条数。evidence必须与issue同级，正文每条至少200字符；不得通过重复填充来满足长度。不要从零重复搜索已经有的事件。`;
    checkpoint.validationError = error.message;
    bundle = null;
  }
  if (!bundle) {
    const guardState = await initializeSearchBudget(path.join(folder, 'search-cache'));
    const rateState = await readJson(path.join(root, 'data/runtime/exa-rate-limit.json'), guardState);
    if (rateState?.blockedUntil - Date.now() > (config.exaPolicy?.maxWaitMs ?? 60000)) throw new Error(`Exa限流等待至${new Date(rateState.blockedUntil).toISOString()}（依据：${rateState.retrySource || '旧版本地冷却策略'}），本次不消耗制作尝试次数；可以复用缓存，稍后恢复。`);
    if (checkpoint.attempts >= config.maxAttemptsPerDay && !retryFailed) throw new Error('本刊Pi尝试次数已达上限，请检查私有日志；修复后可用 --resume-date=日期 --retry-failed 显式追加一次，不会自动无限重跑。');
    await preflight();
    if (retryFailed) {
      checkpoint.retryAuthorizations ||= [];
      checkpoint.retryAuthorizations.push({ at: new Date().toISOString(), attempt: checkpoint.attempts + 1, reason: 'operator --resume-date --retry-failed; existing attempts and logs retained' });
    }
    checkpoint.attempts++; checkpoint.status = 'running';
    await saveJson(checkpointFile, checkpoint);
    await atomicWrite(promptFile, makePiPrompt({ date, window: checkpoint.window, target, output, smoke, backfill, generatedAt: now.toISOString() }) + `\n本刊已取得的搜索资料索引：${path.join(folder, 'search-cache/index.json')}（存在则先read复用；不存在可忽略）。相同请求被缓存拦截时读取返回的缓存文件，不要换参数绕过。\n${budgetSummary(guardState, smoke ? { maxSearch: 4, maxFetch: 3, maxCalls: 7 } : {})}` + repair);
    let processError;
    try {
      try { await invokePi({ root, config, promptFile, logFile: path.join(folder, `attempt-${checkpoint.attempts}.private.log`), timeoutMinutes: smoke ? config.smokeTimeoutMinutes : config.timeoutMinutes }); }
      catch (error) { processError = error; throw error; }
      bundle = await readJson(output);
      validatePiBundle(bundle, validation);
    } catch (error) {
      // A final model reply can fail after the completed file was written.
      // Only accept the artifact if every normal validation still passes.
      try {
        bundle = await readJson(output);
        validatePiBundle(bundle, validation);
        checkpoint.recoveredAfterProcessError = true;
      } catch (validationError) {
        checkpoint.status = 'failed';
        checkpoint.diagnostics = diagnoseRun(await readFile(path.join(folder, `attempt-${checkpoint.attempts}.private.log`), 'utf8').catch(() => ''));
        if (processError) checkpoint.providerError = processError.message;
        else if (checkpoint.diagnostics.terminalProviderError) checkpoint.providerError = checkpoint.diagnostics.terminalProviderError;
        else delete checkpoint.providerError;
        checkpoint.validationError = validationError.message;
        await saveJson(checkpointFile, checkpoint);
        const artifact = validationError.code === 'ENOENT'
          ? `未生成产物 ${output}`
          : `产物校验：${validationError.message}`;
        const failure = new Error(`${error.message}；${artifact}`);
        failure.infrastructure = !!(checkpoint.diagnostics.terminalProviderError || checkpoint.diagnostics.searchToolsUnavailable);
        throw failure;
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
  const accessCorrections = await alignSourceAccessTimes(issue, folder);
  if (accessCorrections.length) await saveJson(path.join(folder, 'source-access-corrections.json'), accessCorrections);
  issue.scope = `${checkpoint.window.start} 至 ${checkpoint.window.end}；实际 ${issue.stories.length}/${target} 条。`;
  issue.notice = `${backfill ? `补刊：于${chinaDate(now)}补建，资料在历史截止时间之后整理，不是当日网页快照。` : ''}${issue.notice || ''} 自动化检查不等于独立事实核验。${checkpoint.window.gap ? '更早断更区间未覆盖。' : ''}`;
  for (const story of issue.stories) story.status = 'Pi自动生成 · 未经人工逐条核验';
  await saveJson(path.join(root, 'data/issues', dp, 'issue.json'), issue);
  await saveJson(path.join(root, 'data/evidence', dp, 'pi-evidence.json'), bundle.evidence);
  const position = publicationPosition(state, date, checkpoint.window.end);
  await publish(root, issue, { latest: position.latest });
  state.lastCutoff = position.lastCutoff;
  state.published[date] = { engine: 'pi', count: issue.stories.length, cutoff: issue.cutoff, path: `issues/${dp}/index.html`, ...(backfill ? { backfilledAt: new Date().toISOString() } : {}) };
  await saveJson(stateFile, state);
  checkpoint.status = 'published'; await saveJson(checkpointFile, checkpoint);
  console.log(`已发布 ${issue.stories.length}/${target} 条：${date}，public/issues/${dp}/index.html${position.latest ? '（最新首页已更新）' : '（最新首页保持不变）'}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--smoke', '--no-sync', '--retry-failed'].includes(arg) && !/^--(?:resume-date|backfill-date)=\d{4}-\d{2}-\d{2}$/.test(arg))) throw new Error('参数不合法');
  const resumeDate = args.find(arg => arg.startsWith('--resume-date='))?.split('=')[1];
  const backfillDate = args.find(arg => arg.startsWith('--backfill-date='))?.split('=')[1];
  const retryFailed = args.includes('--retry-failed');
  if (retryFailed && !resumeDate) throw new Error('--retry-failed 必须与 --resume-date 配合，仅追加该刊一次尝试');
  const now = new Date(), today = chinaDate(now);
  const modes = args.filter(arg => arg === '--check' || arg === '--smoke' || arg.startsWith('--resume-date=') || arg.startsWith('--backfill-date='));
  if (modes.length > 1) throw new Error('检查、测试、恢复和补刊模式不能混用');
  if (resumeDate) { shiftDate(resumeDate, 0); if (resumeDate > today) throw new Error('恢复日期不合法'); }
  if (backfillDate) { shiftDate(backfillDate, 0); if (backfillDate >= today) throw new Error('补刊日期必须早于今天'); }
  const config = await readJson(path.join(root, 'config/pi.json'));
  const settings = await readJson(path.join(root, 'config/settings.json'));
  await resolvePi(config);
  if (args.includes('--check')) { console.log('Pi CLI路径可用；不读取密钥。使用 npm run pi:smoke 检查实际模型与搜索能力。'); return; }
  const smoke = args.includes('--smoke');
  const release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
  try {
    const state = await readJson(path.join(root, 'data/runtime/state.json'), { lastCutoff: null, published: {} });
    const checkpointDates = (await filesUnder(path.join(root, 'data/pi-runs')))
      .map(file => path.relative(path.join(root, 'data/pi-runs'), file).replaceAll('\\', '/'))
      .filter(file => /^\d{4}\/\d{2}\/\d{2}\/checkpoint\.json$/.test(file))
      .map(file => file.slice(0, 10).replaceAll('/', '-'));
    const dates = smoke ? [today] : resumeDate || backfillDate ? [resumeDate || backfillDate] : pendingIssueDates(state, checkpointDates, today);
    if (!dates.length) { console.log('历史刊期与当天均已发布，不重复运行。'); return; }
    console.log('制作顺序：' + dates.join(' → '));
    const errors = [];
    let preflightResult;
    let infrastructureFailure;
    const preflight = () => {
      if (infrastructureFailure) throw new Error('共同依赖故障，本批剩余联网制作暂停：' + infrastructureFailure);
      return preflightResult ||= checkPiMcp(config, root);
    };
    for (const date of dates) {
      // Content repair reuses the saved window, cache and attempt counter. Never
      // retry provider failures or grant extra attempts in an automatic run.
      for (let pass = 0; ; pass++) {
        const checkpointFile = path.join(root, 'data/pi-runs', datePath(date), 'checkpoint.json');
        const before = !smoke && await readJson(checkpointFile, null);
        try { await produceIssue({ date, now, state, config, settings, smoke, resumeDate, retryFailed, preflight }); break; }
        catch (error) {
          if (error.infrastructure) infrastructureFailure = error.message;
          const after = !smoke && await readJson(checkpointFile, null);
          if (!smoke && !retryFailed && !error.infrastructure && !infrastructureFailure && after?.status === 'failed'
            && after.validationError && !after.providerError && after.attempts > (before?.attempts || 0)
            && after.attempts < config.maxAttemptsPerDay && pass + 1 < config.maxAttemptsPerDay) {
            console.error(`${date}：本次稿件校验失败，自动恢复（已用${after.attempts}/${config.maxAttemptsPerDay}次）；保留原窗口和缓存。`);
            continue;
          }
          errors.push(date + '：' + error.message); console.error(errors.at(-1));
          break;
        }
      }
    }
    if (errors.length) throw new Error('部分刊期未完成：' + errors.join('；'));
  } finally {
    try { await updateLedger(root, today); }
    catch { console.error('用量台账更新失败，请检查operations任务。'); }
    await release();
    if (!smoke && !args.includes('--no-sync')) {
      try { await syncGit(root); console.log('GitHub同步完成。'); }
      catch (e) { console.error(e.message); }
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
