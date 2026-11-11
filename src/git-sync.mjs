import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { acquireLock, saveJson, chinaDate } from './runtime.mjs';
const exec = promisify(execFile);
const remote = 'https://github.com/LiangJiayi666/Insight.git';
const roots = ['.gitignore', '.env.example', 'README.md', 'package.json', 'index.html', 'styles.css', 'app.js', 'config/settings.json', 'config/sources.json', 'config/pi.json', 'scripts', 'src', 'tests', 'docs', 'archive', 'public', 'data/issues'];
export function allowedGitPath(file) {
  return roots.some(root => file === root || file.startsWith(root + '/')) && !/(^|\/)(\.env|node_modules|backups|logs)(\/|$)/.test(file) && !/\.(private\.log|bak|tmp)$/.test(file);
}
export async function syncGit(root) {
  const release = await acquireLock(path.join(root, 'data/runtime/git-sync.lock'));
  const git = async (...args) => (await exec('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  const record = { at: new Date().toISOString(), status: 'started' };
  try {
    if (await git('remote', 'get-url', 'origin') !== remote) throw new Error('Git远程地址不匹配');
    if (await git('branch', '--show-current') !== 'main') throw new Error('自动同步仅允许main分支');
    const staged = (await git('diff', '--cached', '--name-only')).split('\n').filter(Boolean);
    if (staged.some(file => !allowedGitPath(file))) throw new Error('暂存区包含非公开文件，停止自动提交');
    await git('add', '--', ...roots);
    const files = (await git('diff', '--cached', '--name-only')).split('\n').filter(Boolean);
    if (files.some(file => !allowedGitPath(file))) throw new Error('检测到不允许上传的路径');
    if (files.length) await git('commit', '-m', `Daily update ${chinaDate()}`);
    // Never force-push or auto-merge remote edits. A conflict requires local review.
    await git('push', 'origin', 'main');
    record.status = 'pushed'; record.commit = await git('rev-parse', 'HEAD');
    return record;
  } catch {
    record.status = 'failed';
    throw new Error('GitHub同步失败；已保留本地文件/提交。检查登录、网络或远端冲突，不会强推。');
  } finally { await saveJson(path.join(root, 'data/runtime/git-sync.json'), record); await release(); }
}
