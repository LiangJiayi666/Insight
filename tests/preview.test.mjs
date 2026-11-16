import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const root = new URL('../', import.meta.url);
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
    assert.equal(await (await fetch(base)).text(), await readFile(new URL('public/index.html', root), 'utf8'));
    for (const denied of ['/package.json', '/data/runtime/state.json', '/archive/prototype.html']) assert.equal((await fetch(base + denied)).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal(await (await fetch(base, { method: 'HEAD' })).text(), '');
  } finally { child.kill(); }
});

test('missing public output does not fall back to a root-level prototype', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'insight-preview-'));
  let child;
  try {
    await mkdir(path.join(folder, 'scripts'));
    await cp(new URL('../scripts/serve.mjs', import.meta.url), path.join(folder, 'scripts/serve.mjs'));
    await writeFile(path.join(folder, 'index.html'), 'retired prototype must not be served');
    const port = 40000 + Math.floor(Math.random() * 10000);
    child = spawn(process.execPath, [path.join(folder, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Preview timeout')), 5000); timer.unref(); }),
    ]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(folder, { recursive: true, force: true });
  }
});
