import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJson } from './runtime.mjs';

export async function resolvePi(config, env = process.env) {
  const packageRoot = env.APPDATA && path.join(env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
  const guesses = [env.INSIGHT_PI_CLI, config.cliPath,
    packageRoot && path.join(packageRoot, 'dist/bundle/cli.js'),
    packageRoot && path.join(packageRoot, 'dist/cli.js')].filter(Boolean);
  for (const file of guesses) { try { await access(file); return file; } catch {} }
  throw new Error('未找到Pi CLI；在config/pi.json设置cliPath，或设置INSIGHT_PI_CLI。');
}
export function piArgs(cli, config, promptFile) {
  return ['--import', new URL('../scripts/pi-exa-observer.mjs', import.meta.url).href, cli, '--extension', fileURLToPath(new URL('../scripts/pi-search-guard.ts', import.meta.url)), '--print', '--mode', 'json', '--no-session', config.projectTrust === 'approve' ? '--approve' : '--no-approve',
    '--tools', config.tools.join(','), ...(config.model ? ['--model', config.model] : []), '@' + promptFile];
}
export async function invokePi({ root, config, promptFile, logFile, timeoutMinutes }) {
  const cli = await resolvePi(config);
  await mkdir(path.dirname(logFile), { recursive: true });
  const log = await open(logFile, 'a');
  try {
    await new Promise((resolve, reject) => {
      const args = piArgs(cli, config, promptFile);
      args[args.indexOf('--extension') + 1] = path.join(root, 'scripts/pi-search-guard.ts');
      const child = spawn(process.execPath, args, {
        cwd: root, env: { ...process.env, INSIGHT_SEARCH_CACHE: path.join(path.dirname(logFile), 'search-cache'), INSIGHT_EXA_RATE_LIMIT_STATE: path.join(root, 'data/runtime/exa-rate-limit.json'), INSIGHT_EXA_POLICY: JSON.stringify(config.exaPolicy || {}) }, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
      });
      const processFile = path.join(path.dirname(logFile), 'process.json');
      const startedAt = new Date().toISOString();
      const heartbeat = () => saveJson(processFile, { parentPid: process.pid, childPid: child.pid, startedAt, heartbeatAt: new Date().toISOString(), logFile, status: 'running' }).catch(() => {});
      void heartbeat();
      const heartbeatTimer = setInterval(heartbeat, 30000);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
        else child.kill('SIGTERM');
      }, timeoutMinutes * 60000);
      child.once('error', () => { clearInterval(heartbeatTimer); clearTimeout(timer); reject(new Error('无法启动独立Pi进程')); });
      child.once('close', code => {
        clearInterval(heartbeatTimer);
        void saveJson(processFile, { parentPid: process.pid, childPid: child.pid, startedAt, endedAt: new Date().toISOString(), code, status: timedOut ? 'timeout' : 'exited' }).catch(() => {});
        clearTimeout(timer);
        if (timedOut) reject(new Error('Pi任务超时，未发布日报'));
        else if (code !== 0) reject(new Error(`Pi退出码 ${code}；请在本地检查私有运行日志`));
        else resolve();
      });
    });
  } finally { await log.close(); }
}
