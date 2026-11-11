import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inlineDailyAssets, prepareDailyAttachment } from '../src/daily-attachment.mjs';
const html = '<link rel="stylesheet" href="styles.css"><details><summary>News</summary>Text</details><script src="app.js" defer></script>';
test('single file embeds exact assets, preserves replacement tokens and rejects malformed input', () => {
  const output = inlineDailyAssets(html, 'a{color:red}', 'const x="$&";');
  assert.ok(output.includes('const x="$&";'));
  assert.ok(!output.includes('src="app.js"'));
  assert.ok(output.includes('<details>'));
  assert.throws(() => inlineDailyAssets('bad', '', ''), /结构/);
  assert.throws(() => inlineDailyAssets(html, '</style>', ''), /结束标记/);
});
test('attachment selects latest published archive and labels stale editions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-attachment-'));
  try {
    await assert.rejects(prepareDailyAttachment(root), /还没有/);
    await mkdir(path.join(root, 'data/runtime'), { recursive: true });
    await writeFile(path.join(root, 'data/runtime/state.json'), JSON.stringify({ published: { '2026-11-11': { count: 12, path: '../../secret' } } }));
    const archive = path.join(root, 'public/issues/2026/11/11');
    await mkdir(archive, { recursive: true });
    for (const [name, text] of [['index.html', html], ['styles.css', 'body{}'], ['app.js', 'console.log(1)']]) await writeFile(path.join(archive, name), text);
    const result = await prepareDailyAttachment(root, new Date('2026-11-12T00:00:00Z'));
    assert.equal(result.count, 12); assert.ok(result.description.includes('今天尚未发布'));
    assert.ok((await readFile(result.filename, 'utf8')).includes('<style>body{}</style>'));
    const today = await prepareDailyAttachment(root, new Date('2026-11-11T00:00:00Z'));
    assert.ok(today.description.includes('今天已发布'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
