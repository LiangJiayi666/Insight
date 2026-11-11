import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, atomicWrite, acquireLock, chinaDate, datePath, computeWindow } from '../src/runtime.mjs';
import { invokePi, resolvePi } from '../src/pi-runner.mjs';
import { makePiPrompt, validatePiBundle } from '../src/pi-contract.mjs';
import { publish } from '../src/pipeline.mjs';
import { updateLedger } from '../src/operations.mjs';
import { syncGit } from '../src/git-sync.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--smoke'].includes(arg))) throw new Error('仅支持 --check 或 --smoke');
  const config = await readJson(path.join(root, 'config/pi.json'));
  const settings = await readJson(path.join(root, 'config/settings.json'));
  await resolvePi(config);
  if (args.includes('--check')) { console.log('Pi CLI路径可用；不读取密钥。使用 npm run pi:smoke 检查实际模型与搜索能力。'); return; }
  const smoke = args.includes('--smoke');
  const release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
  try {
    const now = new Date(); const date = chinaDate(now); const dp = datePath(date);
    const stateFile = path.join(root, 'data/runtime/state.json');
    const state = await readJson(stateFile, { lastCutoff: null, published: {} });
    if (!smoke && state.published[date]) { console.log('本日已发布，不重复运行。'); return; }
    const folder = path.join(root, 'data', smoke ? 'pi-smoke' : 'pi-runs', smoke ? now.toISOString().replace(/[:.]/g, '-') : dp);
    const checkpointFile = path.join(folder, 'checkpoint.json');
    const checkpoint = await readJson(checkpointFile, { date, window: computeWindow(now, smoke ? null : state.lastCutoff, settings), attempts: 0 });
    const target = smoke ? 1 : settings.targetStories;
    const output = path.join(folder, 'bundle.json');
    const promptFile = path.join(folder, 'prompt.txt');
    let bundle;
    let repair = '';
    try {
      bundle = await readJson(output, null);
      if (bundle) validatePiBundle(bundle, { date, window: checkpoint.window, target });
    } catch (error) {
      repair = `\n恢复任务：先读取已有 ${output}，上次校验错误：${error.message}。保留有来源支撑的内容，修复结构及缺失证据，再继续补充不同事件至目标。evidence必须与issue同级，正文每条至少200字符；不得通过重复填充来满足长度。重新读取来源取得正文。不要从零重复搜索已经有的事件。`;
      checkpoint.validationError = error.message;
      bundle = null;
    }
    if (!bundle) {
      if (checkpoint.attempts >= config.maxAttemptsPerDay) throw new Error('本日Pi尝试次数已达上限，请检查私有日志；不会自动无限重跑。');
      checkpoint.attempts++; checkpoint.status = 'running';
      await saveJson(checkpointFile, checkpoint);
      await atomicWrite(promptFile, makePiPrompt({ date, window: checkpoint.window, target, output, smoke }) + repair);
      try {
        await invokePi({ root, config, promptFile, logFile: path.join(folder, `attempt-${checkpoint.attempts}.private.log`), timeoutMinutes: smoke ? config.smokeTimeoutMinutes : config.timeoutMinutes });
        bundle = await readJson(output);
        validatePiBundle(bundle, { date, window: checkpoint.window, target });
      } catch (error) {
        // A final model reply can fail after the completed file was written.
        // Only accept the artifact if every normal validation still passes.
        try {
          bundle = await readJson(output);
          validatePiBundle(bundle, { date, window: checkpoint.window, target });
          checkpoint.recoveredAfterProcessError = true;
        } catch (validationError) {
          checkpoint.status = 'failed';
          checkpoint.validationError = validationError.message;
          await saveJson(checkpointFile, checkpoint);
          throw new Error(`${error.message}；产物校验：${validationError.message}`);
        }
      }
    }
    if (smoke) {
      checkpoint.status = 'smoke-passed'; await saveJson(checkpointFile, checkpoint);
      console.log(`Pi真实调用测试通过：${bundle.issue.stories.length}条，保存在 ${folder}；未发布、未推送。`); return;
    }
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
    if (!smoke) {
      try { await syncGit(root); console.log('GitHub同步完成。'); }
      catch (e) { console.error(e.message); }
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
