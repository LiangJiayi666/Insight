import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderIssue } from '../src/render.mjs';
import { acquireLock } from '../src/runtime.mjs';

test('offline build uses the production renderer and older rebuilds preserve the latest home page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-build-'));
  try {
    await cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'scripts'));
    await cp(new URL('../scripts/render.mjs', import.meta.url), path.join(root, 'scripts/render.mjs'));
    for (const file of ['styles.css', 'app.js']) await cp(new URL(`../${file}`, import.meta.url), path.join(root, file));
    for (const day of ['11', '12']) await cp(new URL(`../data/issues/2026/11/${day}/`, import.meta.url), path.join(root, 'data/issues/2026/11', day), { recursive: true });
    const run = (...args) => promisify(execFile)(process.execPath, [path.join(root, 'scripts/render.mjs'), ...args], { cwd: root, timeout: 10000, windowsHide: true });
    await run();
    const issue = JSON.parse(await readFile(path.join(root, 'data/issues/2026/11/12/issue.json'), 'utf8'));
    const latest = await readFile(path.join(root, 'public/index.html'), 'utf8');
    assert.equal(latest, renderIssue(issue));
    await run('2026-11-11');
    assert.equal(await readFile(path.join(root, 'public/index.html'), 'utf8'), latest);
    await access(path.join(root, 'public/issues/2026/11/11/index.html'));
    await assert.rejects(access(path.join(root, 'data/runtime/state.json')), { code: 'ENOENT' });
    await assert.rejects(run('2026-10-01'), /没有对应/);
    await assert.rejects(run('../../private'), /用法/);
    const release = await acquireLock(path.join(root, 'data/runtime/daily.lock'));
    try { await assert.rejects(run(), /存在运行锁/); }
    finally { await release(); }
    assert.equal(await readFile(path.join(root, 'public/index.html'), 'utf8'), latest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
