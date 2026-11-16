import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderIssue, validateIssue, safeUrl, escapeHtml } from '../src/render.mjs';
const issue = JSON.parse(await readFile(new URL('../data/issues/2026/11/11/issue.json', import.meta.url), 'utf8'));

test('issue facts have references, dates and source limits', () => {
  assert.doesNotThrow(() => validateIssue(issue));
  assert.equal(issue.sources.length, 12);
  assert.equal(issue.stories.length, 12);
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
  assert.equal(await readFile(new URL('../public/issues/2026/11/11/index.html', import.meta.url), 'utf8'), rendered);
});

test('current renderer produces closed, accessible, independently linked stories', () => {
  const html = renderIssue(issue);
  assert.equal((html.match(/class="story"/g) || []).length, issue.stories.length);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(html, /<details\b[^>]*\bopen(?:\s|=|>)/i);
  for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(anchor));
  const details = (html.match(/<details\b/g) || []).length;
  assert.equal(details, (html.match(/<\/details>/g) || []).length);
  assert.equal(details, (html.match(/<summary>/g) || []).length);
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('lang="zh-CN"'));
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});
