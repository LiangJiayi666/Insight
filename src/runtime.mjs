import { mkdir, readFile, writeFile, rename, open, unlink, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, text, 'utf8');
  try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export async function saveJson(file, value) { await atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
export function chinaDate(now = new Date()) { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
export function datePath(date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date'); return date.replaceAll('-', '/'); }
export async function loadEnv(file) {
  let text; try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
export async function acquireLock(file) {
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try { handle = await open(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('存在运行锁。确认无任务运行后，使用 npm run unlock 清理；不会自动夺取锁。'); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  return async () => { await unlink(file); };
}
export async function logEvent(file, event, fields = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  // Callers pass structured counters/status only, never raw HTTP bodies or credentials.
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}
export function computeWindow(now, lastCutoff, settings) {
  const end = new Date(now).getTime();
  const wanted = lastCutoff ? Date.parse(lastCutoff) : end - settings.initialLookbackHours * 3600000;
  if (!Number.isFinite(wanted) || wanted >= end) throw new Error('采集窗口无效');
  const start = Math.max(wanted, end - settings.maxCatchupHours * 3600000);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), gap: start > wanted };
}
