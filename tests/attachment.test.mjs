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
test('attachment packages the requested published edition without falling back to another date', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-attachment-'));
  try {
    await assert.rejects(prepareDailyAttachment(root, '2026-11-11'), /没有有效/);
    await mkdir(path.join(root, 'data/runtime'), { recursive: true });
    await writeFile(path.join(root, 'data/runtime/state.json'), JSON.stringify({ published: { '2026-11-11': { count: 12, path: '../../secret' } } }));
    const archive = path.join(root, 'public/issues/2026/11/11');
    await mkdir(archive, { recursive: true });
    for (const [name, text] of [['index.html', html], ['styles.css', 'body{}'], ['app.js', 'console.log(1)']]) await writeFile(path.join(archive, name), text);
    const result = await prepareDailyAttachment(root, '2026-11-11');
    assert.equal(result.count, 12); assert.equal(result.date, '2026-11-11');
    assert.ok((await readFile(result.filename, 'utf8')).includes('<style>body{}</style>'));
    await assert.rejects(prepareDailyAttachment(root, '2026-11-12'), /没有有效/);
    await assert.rejects(prepareDailyAttachment(root, '../../secret'), /Invalid date/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
