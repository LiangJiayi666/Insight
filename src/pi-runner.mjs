import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

export async function resolvePi(config) {
  const guesses = [process.env.INSIGHT_PI_CLI, config.cliPath,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js')].filter(Boolean);
  for (const file of guesses) { try { await access(file); return file; } catch {} }
  throw new Error('未找到Pi CLI；在config/pi.json设置cliPath，或设置INSIGHT_PI_CLI。');
}
export function piArgs(cli, config, promptFile) {
  return [cli, '--print', '--mode', 'json', '--no-session', config.projectTrust === 'approve' ? '--approve' : '--no-approve',
    '--tools', config.tools.join(','), ...(config.model ? ['--model', config.model] : []), '@' + promptFile];
}
export async function invokePi({ root, config, promptFile, logFile, timeoutMinutes }) {
  const cli = await resolvePi(config);
  await mkdir(path.dirname(logFile), { recursive: true });
  const log = await open(logFile, 'a');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, piArgs(cli, config, promptFile), {
        cwd: root, env: process.env, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
        else child.kill('SIGTERM');
      }, timeoutMinutes * 60000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动独立Pi进程')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('Pi任务超时，未发布日报'));
        else if (code !== 0) reject(new Error(`Pi退出码 ${code}；请在本地检查私有运行日志`));
        else resolve();
      });
    });
  } finally { await log.close(); }
}
