import path from 'node:path';
import os from 'node:os';
import { readFile, readdir, stat, mkdir, copyFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, saveJson, chinaDate, datePath, acquireLock } from './runtime.mjs';
import { prepareDailyAttachment } from './daily-attachment.mjs';

export async function filesUnder(folder) {
  let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
export function parseUsage(text) {
  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, turns: 0, errors: 0, tools: {}, models: [], reportedCost: 0, priceIncomplete: false, missingUsage: false };
  const evidence = []; const seen = new Set();
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'tool_execution_start') result.tools[e.toolName] = (result.tools[e.toolName] || 0) + 1;
    if (e.type === 'tool_execution_end' && /web_fetch_exa|web_search_exa/.test(e.toolName || '')) evidence.push(e);
    const m = e.message;
    if (e.type !== 'message_end' || m?.role !== 'assistant') continue;
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    result.turns++;
    if (m.stopReason === 'error') result.errors++;
    if (!m.usage) result.missingUsage = true;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) result[key] += Number(m.usage?.[key]) || 0;
    const cost = Number(m.usage?.cost?.total) || 0;
    result.reportedCost += cost;
    if (!cost && (m.usage?.totalTokens || 0) > 0) result.priceIncomplete = true;
    const model = `${m.provider || 'unknown'}/${m.model || 'unknown'}`;
    if (!result.models.includes(model)) result.models.push(model);
  }
  if (!result.turns) result.missingUsage = true;
  return { usage: result, evidence };
}
export async function updateLedger(root, date) {
  const ledgerFile = path.join(root, 'data/costs', datePath(date) + '.json');
  const ledger = await readJson(ledgerFile, { date, runs: {} });
  const logs = [...await filesUnder(path.join(root, 'data/pi-runs', datePath(date))), ...await filesUnder(path.join(root, 'data/pi-smoke'))].filter(f => f.endsWith('.private.log'));
  for (const file of logs) {
    if (file.includes(`${path.sep}pi-smoke${path.sep}`)) {
      const stamp = path.basename(path.dirname(file)).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      if (!Number.isFinite(Date.parse(stamp)) || chinaDate(new Date(stamp)) !== date) continue;
    }
    const key = path.relative(root, file).replaceAll('\\', '/');
    const { usage, evidence } = parseUsage(await readFile(file, 'utf8'));
    ledger.runs[key] = usage;
    if (evidence.length) {
      const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await saveJson(path.join(root, 'data/source-results', datePath(date), `${id}.json`), { run: key, note: '原样保存Pi工具结束事件；服务返回文本可能截断，不等于网页完整HTML快照。', events: evidence });
    }
  }
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, errors: 0, search: 0, fetch: 0, incomplete: false, credits: null, money: null };
  for (const run of Object.values(ledger.runs)) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'errors']) total[k] += run[k];
    total.search += run.tools.mcp__exa__web_search_exa || 0;
    total.fetch += run.tools.mcp__exa__web_fetch_exa || 0;
    total.incomplete ||= run.missingUsage;
  }
  ledger.total = total; ledger.updatedAt = new Date().toISOString();
  ledger.scope = '仅Insight的Pi制作与测试，含失败运行的可观测用量；不含普通飞书聊天。金额/credits未经供应商账单确认。';
  await saveJson(ledgerFile, ledger);
  return ledger;
}
export function costText(ledger, count) {
  const t = ledger.total; const n = x => x.toLocaleString('en-US');
  return `见微每日用量｜${ledger.date}\n日报：${count ? `已发布${count}条` : '尚未发布'}\nToken合计：${n(t.totalTokens)}${t.incomplete ? '（统计不完整，至少）' : ''}\n输入 ${n(t.input)} · 输出 ${n(t.output)}\n缓存读取 ${n(t.cacheRead)} · 缓存写入 ${n(t.cacheWrite)}\n搜索 ${t.search}次 · 网页读取 ${t.fetch}次\nCredits / 金额：未知（未接入供应商计费规则）\n含当日制作、测试和失败尝试；不含普通机器人聊天。${t.incomplete ? '\n部分旧日志无用量，不能视为零消耗。' : ''}\n发送“日报”获取附件。`;
}
export async function notifyCosts(root, ledger, deliveryKey = ledger.date) {
  const directory = path.join(os.homedir(), '.pi/feishu-bridge');
  const config = JSON.parse((await readFile(path.join(directory, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const owner = await readJson(path.join(directory, 'owner.json'));
  if (!owner.chatId || !owner.openId) throw new Error('未绑定飞书收件人');
  const file = path.join(root, 'data/delivery-ledger', `${deliveryKey}-cost.json`);
  const record = await readJson(file, { date: ledger.date, uuid: randomUUID(), status: 'pending', attempts: 0 });
  if (record.status === 'sent') return 'already-sent';
  const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
  const yesterday = chinaDate(new Date(Date.parse(`${ledger.date}T12:00:00Z`) - 86400000));
  const attachmentDate = state.published[ledger.date] ? ledger.date : state.published[yesterday] ? yesterday : null;
  const text = costText(ledger, state.published[ledger.date]?.count) + (attachmentDate && attachmentDate !== ledger.date ? `\n今天尚未出刊，本次附上昨天（${attachmentDate}）的日报。` : '');
  const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }), signal: AbortSignal.timeout(30000) });
  const auth = await tokenResponse.json();
  if (!tokenResponse.ok || auth.code !== 0 || !auth.tenant_access_token) throw new Error('飞书日报用量认证失败');
  record.attempts++; record.status = 'sending'; record.lastAttempt = new Date().toISOString();
  await saveJson(file, record);
  try {
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', { method: 'POST', headers: { Authorization: `Bearer ${auth.tenant_access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ receive_id: owner.chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: record.uuid }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) throw new Error('飞书用量通知未确认成功');
    record.status = 'sent'; record.messageId = data.data?.message_id; record.sentAt = new Date().toISOString();
  } catch (e) { record.status = 'uncertain'; throw e; }
  finally { await saveJson(file, record); }
  return 'sent';
}
export async function notifyDaily(root, date, request = fetch, deliveryKey = date) {
  const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
  const file = path.join(root, 'data/delivery-ledger', `${deliveryKey}-daily.json`);
  const record = await readJson(file, { date, uuid: randomUUID(), status: 'pending', attempts: 0 });
  if (record.status === 'sent') return 'already-sent';
  const yesterday = chinaDate(new Date(Date.parse(`${date}T12:00:00Z`) - 86400000));
  const editionDate = state.published[date] ? date : state.published[yesterday] ? yesterday : null;
  const attachment = editionDate ? await prepareDailyAttachment(root, new Date(`${editionDate}T12:00:00Z`)) : null;
  if (attachment && attachment.date !== editionDate) throw new Error('日报刊期不匹配');
  record.editionDate = editionDate;
  const directory = path.join(os.homedir(), '.pi/feishu-bridge');
  const config = JSON.parse((await readFile(path.join(directory, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const owner = await readJson(path.join(directory, 'owner.json'));
  if (!owner.chatId || !owner.openId) throw new Error('未绑定飞书收件人');
  const authResponse = await request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }), signal: AbortSignal.timeout(30000) });
  const auth = await authResponse.json();
  if (!authResponse.ok || auth.code !== 0 || !auth.tenant_access_token) throw new Error('飞书日报认证失败');
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
  record.attempts++; record.status = 'sending'; record.lastAttempt = new Date().toISOString();
  await saveJson(file, record);
  try {
    let content; let type;
    if (attachment) {
      if (!record.fileKey) {
        const form = new FormData();
        form.set('file_type', 'stream');
        form.set('file_name', path.basename(attachment.filename));
        form.set('file', new Blob([await readFile(attachment.filename)]), path.basename(attachment.filename));
        const uploadResponse = await request('https://open.feishu.cn/open-apis/im/v1/files', { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000) });
        const uploaded = await uploadResponse.json();
        if (!uploadResponse.ok || uploaded.code !== 0 || !uploaded.data?.file_key) throw new Error('日报附件上传失败');
        record.fileKey = uploaded.data.file_key;
        await saveJson(file, record);
      }
      type = 'file'; content = { file_key: record.fileKey };
    } else {
      type = 'text'; content = { text: `${date}的日报尚未生成，昨天也没有可用日报。制作完成后，再发送“日报”即可获取台账和日报。` };
    }
    const response = await request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ receive_id: owner.chatId, msg_type: type, content: JSON.stringify(content), uuid: record.uuid }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) throw new Error('日报发送未确认成功');
    record.status = 'sent'; record.kind = type; record.messageId = data.data?.message_id; record.sentAt = new Date().toISOString();
  } catch (e) { record.status = 'uncertain'; throw e; }
  finally { await saveJson(file, record); }
  return attachment ? 'file-sent' : 'unavailable-notice-sent';
}

// Both the 22:00 job and the bound user's 日报 command call this exact action.
export async function deliverDailyReport(root, { requestId, now = new Date() } = {}) {
  const release = await acquireLock(path.join(root, 'data/runtime/report-delivery.lock'));
  try {
    const date = chinaDate(now);
    const key = requestId ? `${date}-request-${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}` : date;
    const ledger = await updateLedger(root, date);
    const result = {}; const errors = [];
    try { result.cost = await notifyCosts(root, ledger, key); } catch (e) { errors.push(e.message); }
    try { result.daily = await notifyDaily(root, date, fetch, key); } catch (e) { errors.push(e.message); }
    if (errors.length) throw new Error(errors.join('；'));
    return result;
  } finally { await release(); }
}

export async function maintain(root, now = new Date()) {
  const date = chinaDate(now); const backup = path.join(root, 'backups', date);
  const manifest = [];
  for (const relative of ['config', 'data/issues', 'data/evidence', 'data/source-results', 'data/costs', 'data/delivery-ledger', 'data/runtime/state.json']) {
    const source = path.join(root, relative);
    let files;
    try { files = (await stat(source)).isFile() ? [source] : await filesUnder(source); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const file of files) {
      const rel = path.relative(root, file); const destination = path.join(backup, rel);
      await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file, destination);
      const hash = data => createHash('sha256').update(data).digest('hex');
      const digest = hash(await readFile(file));
      if (digest !== hash(await readFile(destination))) throw new Error('备份校验失败');
      manifest.push({ path: rel, sha256: digest });
    }
  }
  await saveJson(path.join(backup, 'manifest.json'), { date, verifiedAt: now.toISOString(), files: manifest, note: '同盘备份，仅防误改；不防磁盘损坏。可用issue.json重建HTML。' });
  let removed = 0;
  for (const [relative, days] of [['data/pi-runs', 30], ['data/pi-smoke', 7], ['data/deliveries', 7], ['backups', 7]]) {
    for (const file of await filesUnder(path.join(root, relative))) {
      if (relative === 'data/pi-runs' && !file.endsWith('.private.log')) continue;
      if (now.getTime() - (await stat(file)).mtimeMs > days * 86400000) { await unlink(file); removed++; }
    }
  }
  return { backup, verifiedFiles: manifest.length, removed };
}
