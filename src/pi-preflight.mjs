import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePi } from './pi-runner.mjs';

export function validateMcpStatus(status) {
  const server = status.servers?.find(item => item.name === 'exa');
  const needed = ['web_search_exa', 'web_fetch_exa'];
  if (!server?.enabled || server.state !== 'connected') throw new Error('Exa MCP未连接；本次不消耗制作尝试次数。运行 pi mcp list 检查连接。');
  const names = (server.tools || []).map(tool => typeof tool === 'string' ? tool : tool.name);
  if (needed.some(name => !names.includes(name)) || server.exposure === 'hidden') throw new Error('Exa MCP缺少可用搜索/读取工具；本次不消耗制作尝试次数。');
  return { server: 'exa', state: 'connected', tools: needed };
}

export async function checkPiMcp(config, root) {
  const cli = await resolvePi(config);
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(process.execPath, [cli, 'mcp', 'list', '--json'], { cwd: root, timeout: 90000, windowsHide: true, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    // Other configured servers may fail while Exa is ready. Never copy raw
    // command output (which can contain credential-bearing transport URLs).
    stdout = error.stdout;
    if (!stdout) throw new Error('Pi MCP预检执行失败或超时；本次不消耗制作尝试次数。');
  }
  let status;
  try { status = JSON.parse(stdout); }
  catch { throw new Error('Pi MCP预检没有返回有效状态；请检查安装版本。'); }
  return validateMcpStatus(status);
}
