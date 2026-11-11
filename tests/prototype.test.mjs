import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');

test('five stories, unique anchors, no initially open detail', () => {
  assert.equal((html.match(/class="story"/g) || []).length, 5);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(html, /<details\b[^>]*\bopen(?:\s|=|>)/i);
  for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(anchor));
});

test('nested content has summaries and balanced detail tags', () => {
  const opens = (html.match(/<details\b/g) || []).length;
  assert.equal(opens, (html.match(/<\/details>/g) || []).length);
  assert.equal(opens, (html.match(/<summary>/g) || []).length);
  assert.ok(opens >= 20);
});

test('real issue disclosures and concrete examples exist', () => {
  for (const text of ['见微日报', '国家统计局', '央视网', '美联储', '原文、核验方式', '本期资料说明']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('lang="zh-CN"'));
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});

test('local preview serves only allowed assets', async () => {
  const port = 24000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, [new URL('scripts/serve.mjs', root).pathname.replace(/^\/(?=[A-Za-z]:)/, '')], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}`); }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('Preview timeout')), 5000); t.unref(); }),
    ]);
    const base = `http://127.0.0.1:${port}`;
    for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'text/javascript']]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
      assert.ok((await response.text()).length > 100);
    }
    assert.equal((await fetch(base + '/package.json')).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal(await (await fetch(base, { method: 'HEAD' })).text(), '');
  } finally { child.kill(); }
});
