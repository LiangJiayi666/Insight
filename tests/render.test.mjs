import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderIssue, validateIssue, safeUrl, escapeHtml } from '../scripts/render.mjs';
const issue = JSON.parse(await readFile(new URL('../data/issues/2026-11-11.json', import.meta.url), 'utf8'));

test('issue facts have references, dates and source limits', () => {
  assert.doesNotThrow(() => validateIssue(issue));
  assert.equal(issue.sources.length, 3);
  assert.equal(issue.stories.length, 5);
});
test('external text is escaped and unsafe URLs rejected', () => {
  assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
  for (const url of ['javascript:alert(1)', 'file:///secret', 'https://user:pass@example.com']) assert.throws(() => safeUrl(url));
  const data = structuredClone(issue);
  data.stories[0].title = '<img src=x onerror=alert(1)>';
  const html = renderIssue(data);
  assert.ok(html.includes('&lt;img'));
  assert.doesNotMatch(html, /<img/);
});
test('missing sources, duplicate ids and future articles fail closed', () => {
  const missing = structuredClone(issue); missing.stories[0].sourceIds = ['missing'];
  assert.throws(() => validateIssue(missing), /不存在的来源/);
  const duplicate = structuredClone(issue); duplicate.stories[1].id = duplicate.stories[0].id;
  assert.throws(() => validateIssue(duplicate), /重复/);
  const future = structuredClone(issue); future.stories[0].published = '2099-01-01';
  assert.throws(() => validateIssue(future), /晚于/);
});
test('checked in page and archive match reproducible build', async () => {
  const rendered = renderIssue(issue);
  for (const path of ['../index.html', '../archive/2026-11-11/index.html']) assert.equal(await readFile(new URL(path, import.meta.url), 'utf8'), rendered);
});
