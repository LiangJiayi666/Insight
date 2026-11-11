import { readJson } from '../src/runtime.mjs';
import { unlink } from 'node:fs/promises';
const file = new URL('../data/runtime/daily.lock', import.meta.url);
try {
  const lock = await readJson(file, null);
  if (!lock) console.log('没有运行锁。');
  else {
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('锁信息异常，请人工检查');
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('锁对应进程仍存在，拒绝清理；请先确认任务状态。');
    await unlink(file); console.log('已清理退出进程留下的锁。');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
