import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observeExaFetch, providerRetry } from '../src/exa-response.mjs';
import { SearchGuard } from '../src/search-guard.mjs';
import { classifyToolFailure } from '../src/tool-failure.mjs';
import { invokePi } from '../src/pi-runner.mjs';

async function folder(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exa-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const limited = headers => ({ isError: true, content: [{ type: 'text', text: 'MCP HTTP request failed with status 429: free MCP rate limit' }], details: { exaHttp: { status: 429, headers } } });

test('Retry-After supports seconds, HTTP dates with clock skew, and reset milliseconds', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.deepEqual(providerRetry(limited({ 'Retry-After': '25', 'x-ratelimit-reset': String(now + 1) }), now), { until: now + 25000, source: 'retry-after' });
  assert.equal(providerRetry(limited({ 'Retry-After': 'Wed, 18 Nov 2026 12:01:30 GMT', date: 'Wed, 18 Nov 2026 12:01:00 GMT' }), now).until, now + 30000);
  assert.equal(providerRetry(limited({ 'Retry-After': 'Wed, 18 Nov 2026 11:59:00 GMT' }), now).until, now);
  for (const reset of [now / 1000 + 90, now + 90000]) assert.equal(providerRetry(limited({ 'x-ratelimit-reset': String(reset) }), now).until, now + 90000);
  for (const invalid of ['', 'tomorrow', '-5']) assert.equal(providerRetry(limited({ 'retry-after': invalid }), now), null);
  assert.equal(providerRetry(limited({ 'bad\nheader': 'value' }), now), null);
});

test('HTTP observer preserves fetch, captures only Exa tool response metadata, and never exposes credentials', async () => {
  const recorded = [], requests = [];
  const response = new Response('private body', { status: 429, headers: { 'retry-after': '7', 'set-cookie': 'secret', 'authorization': 'secret' } });
  const wrapped = observeExaFetch(async (...args) => { requests.push(args); return response; }, event => recorded.push(event), () => 1000);
  const options = { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ method: 'tools/call', params: { name: 'web_search_exa', arguments: { query: 'private search' } } }) };
  assert.equal(await wrapped('https://mcp.exa.ai/mcp?exaApiKey=secret', options), response);
  assert.equal(requests[0][1], options);
  assert.deepEqual(recorded, [{ tool: 'web_search_exa', status: 429, observedAt: 1000, headers: { 'retry-after': '7' } }]);
  assert.equal(await response.text(), 'private body');
  await wrapped('https://other.example/mcp', options);
  await wrapped('https://mcp.exa.ai/mcp', { body: JSON.stringify({ method: 'tools/list' }) });
  assert.equal(recorded.length, 1);
});

test('no production daily cap or fixed interval; calls remain serialized', async t => {
  const root = await folder(t);
  const waits = [];
  const guard = new SearchGuard(root, { sleep: async ms => waits.push(ms) });
  for (let n = 0; n < 65; n++) {
    assert.equal(await guard.before(String(n), 'search', { query: String(n) }), undefined);
    await guard.after(String(n), { content: [], isError: false });
  }
  assert.deepEqual(waits, []);
  assert.match(await guard.budget(), /搜索65次/);
  await guard.before('first', 'fetch', {});
  let entered = false;
  const second = guard.before('second', 'fetch', { different: true }).then(() => { entered = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, false);
  await guard.after('first', { content: [], isError: false });
  await second;
  await guard.after('second', { content: [], isError: false });
});

test('short server delay is awaited exactly, success resets backoff, and cache avoids extra calls', async t => {
  const root = await folder(t); let now = 1000; const waits = [];
  const guard = new SearchGuard(root, { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
  await guard.before('a', 'search', { query: 'a' });
  await guard.after('a', limited({ 'retry-after': '12' }));
  assert.match(await guard.policyStatus(), /服务端Retry-After/);
  assert.equal(await guard.before('b', 'search', { query: 'a' }), undefined);
  assert.deepEqual(waits, [12000]);
  await guard.after('b', { content: [], isError: false });
  assert.equal((await guard.rateState()).blockedUntil, 0);
  assert.equal((await guard.before('c', 'search', { query: 'a' })).block, true);
  assert.match(await guard.budget(), /搜索2次/);
});

test('long provider cooldown is shared across editions and never shortened to the local cap', async t => {
  const root = await folder(t), shared = path.join(root, 'shared.json');
  const options = { rateLimitFile: shared, now: () => 1000, sleep: async () => assert.fail('should not sleep') };
  const first = new SearchGuard(path.join(root, 'one'), options);
  await first.before('a', 'search', {});
  await first.after('a', limited({ 'retry-after': '86400' }));
  const second = new SearchGuard(path.join(root, 'two'), options);
  assert.equal((await second.rateState()).blockedUntil, 86401000);
  assert.match((await second.before('b', 'fetch', {})).reason, /服务端Retry-After/);
  assert.match(await second.budget(), /合计0次/);
});

test('missing provider headers use labeled exponential backoff and at most two consecutive retries', async t => {
  const root = await folder(t); let now = 1000; const waits = [];
  const guard = new SearchGuard(root, { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
  for (let n = 0; n < 3; n++) {
    assert.equal(await guard.before(String(n), 'search', {}), undefined);
    await guard.after(String(n), limited({}));
  }
  assert.deepEqual(waits, [30000, 60000]);
  assert.match(await guard.policyStatus(), /本地指数退避/);
  assert.match((await guard.before('blocked', 'search', {})).reason, /429重试次数已达上限/);
  assert.match(await guard.budget(), /合计3次/);
});

test('402, 401, 403 and network failures are not misclassified as rate limits', async t => {
  for (const status of [402, 401, 403]) {
    const result = { isError: true, status, content: [{ type: 'text', text: 'quota exceeded; rate limit' }] };
    assert.equal(classifyToolFailure(result).rateLimited, false);
    const guard = new SearchGuard(path.join(await folder(t), String(status)));
    await guard.before('a', 'search', {});
    await guard.after('a', result);
    assert.match((await guard.before('b', 'search', {})).reason, /认证或余额错误/);
  }
  assert.equal(classifyToolFailure({ isError: true, content: ['fetch failed'] }).rateLimited, false);
  assert.equal(classifyToolFailure({ isError: false, content: ['HTTP 429 Retry-After: 999999'] }).rateLimited, false);
  const actual = limited({ 'retry-after': '10' });
  actual.content.push({ type: 'text', text: 'Exa限流等待至2026-11-18T12:00:00Z，依据：服务端Retry-After。' });
  assert.equal(classifyToolFailure(actual).rateLimited, true);
  assert.equal(classifyToolFailure(actual).guardBlocked, false);
});

test('Pi invocation preloads observation before the CLI and passes one project-wide cooldown file', async t => {
  const root = await folder(t), cli = path.join(root, 'fake-cli.mjs');
  await writeFile(cli, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'probe.json'))}, JSON.stringify({ observer: Array.isArray(globalThis[Symbol.for('insight.exa.http-responses')]), file: process.env.INSIGHT_EXA_RATE_LIMIT_STATE, policy: JSON.parse(process.env.INSIGHT_EXA_POLICY), args: process.argv.slice(2) }));`);
  await invokePi({ root, config: { cliPath: cli, tools: ['read'], exaPolicy: { maxWaitMs: 1234 } }, promptFile: path.join(root, 'prompt.txt'), logFile: path.join(root, 'run/attempt-1.private.log'), timeoutMinutes: 1 });
  const probe = JSON.parse(await readFile(path.join(root, 'probe.json'), 'utf8'));
  assert.equal(probe.observer, true);
  assert.equal(probe.file, path.join(root, 'data/runtime/exa-rate-limit.json'));
  assert.equal(probe.policy.maxWaitMs, 1234);
  assert.equal(probe.args[probe.args.indexOf('--extension') + 1], path.join(root, 'scripts/pi-search-guard.ts'));
});
