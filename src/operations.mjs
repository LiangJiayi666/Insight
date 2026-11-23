import path from 'node:path';
import os from 'node:os';
import { readFile, readdir, stat, mkdir, copyFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, saveJson, chinaDate, datePath, acquireLock } from './runtime.mjs';
import { prepareDailyAttachment } from './daily-attachment.mjs';
import { shiftDate } from './daily-plan.mjs';

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
export function parseUsage(text, { date, fallbackDate } = {}) {
  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, turns: 0, errors: 0, tools: {}, models: [], reportedCost: 0, priceIncomplete: false, missingUsage: false };
  const evidence = []; const seen = new Set(); const calls = new Map();
  const dates = new Set();
  let eventDate = fallbackDate;
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const stamp = e.message?.timestamp ?? e.timestamp;
    const time = typeof stamp === 'number' ? stamp : Date.parse(stamp);
    if (Number.isFinite(time)) eventDate = chinaDate(new Date(time));
    if (eventDate) dates.add(eventDate);
    if (e.type === 'tool_execution_start') calls.set(e.toolCallId, { name: e.toolName, date: eventDate, local: false, ended: false });
    if (e.type === 'tool_execution_end') {
      const call = calls.get(e.toolCallId);
      if (call) {
        call.ended = true;
        const first = e.result?.content?.find(c => c.type === 'text')?.text || '';
        call.local = !!(e.isError || e.result?.isError) && /同批Exa调用须串行|相同请求已有成功结果|搜索服务限流冷却至|Exa限流等待至|本次运行的429重试次数已达上限|本次运行因Exa认证或余额错误停止联网|本刊搜索\/读取硬预算已用完|本刊分项预算已用完/.test(first);
      }
      if (/web_fetch_exa|web_search_exa/.test(e.toolName || '') && (!date || (call?.date || eventDate) === date)) evidence.push(e);
    }
    if (date && eventDate !== date) continue;
    const m = e.message;
    if (e.type !== 'message_end' || m?.role !== 'assistant') continue;
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    result.turns++;
    if (m.stopReason === 'error') {
      result.errors++;
      // SDK error placeholders with all-zero usage do not prove zero billing.
      if (!m.usage?.totalTokens) result.missingUsage = true;
    }
    if (!m.usage) result.missingUsage = true;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) result[key] += Number(m.usage?.[key]) || 0;
    const cost = Number(m.usage?.cost?.total) || 0;
    result.reportedCost += cost;
    if (!cost && (m.usage?.totalTokens || 0) > 0) result.priceIncomplete = true;
    const model = `${m.provider || 'unknown'}/${m.model || 'unknown'}`;
    if (!result.models.includes(model)) result.models.push(model);
  }
  for (const call of calls.values()) {
    if (call.local || (date && call.date !== date)) continue;
    result.tools[call.name] = (result.tools[call.name] || 0) + 1;
    if (!call.ended && /web_fetch_exa|web_search_exa/.test(call.name)) result.missingUsage = true;
  }
  if (!result.turns) result.missingUsage = true;
  return { usage: result, evidence, dates: [...dates] };
}
export async function updateLedger(root, date) {
  const ledgerFile = path.join(root, 'data/costs', datePath(date) + '.json');
  const ledger = await readJson(ledgerFile, { date, runs: {} });
  const logs = [...await filesUnder(path.join(root, 'data/pi-runs')), ...await filesUnder(path.join(root, 'data/pi-smoke'))].filter(f => {
    const key = path.relative(root, f).replaceAll('\\', '/');
    return /^data\/pi-runs\/\d{4}\/\d{2}\/\d{2}\/attempt-\d+\.private\.log$/.test(key) || /^data\/pi-smoke\/[^/]+\/attempt-\d+\.private\.log$/.test(key);
  });
  // Remove old accidental snapshot copies, but retain canonical entries whose
  // original logs have already passed the retention period.
  for (const key of Object.keys(ledger.runs)) {
    if (!/^data\/pi-runs\/\d{4}\/\d{2}\/\d{2}\/attempt-\d+\.private\.log$/.test(key) && !/^data\/pi-smoke\/[^/]+\/attempt-\d+\.private\.log$/.test(key)) delete ledger.runs[key];
  }
  for (const file of logs) {
    let fallbackDate;
    if (file.includes(`${path.sep}pi-smoke${path.sep}`)) {
      const stamp = path.basename(path.dirname(file)).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      if (Number.isFinite(Date.parse(stamp))) fallbackDate = chinaDate(new Date(stamp));
    } else {
      fallbackDate = path.relative(path.join(root, 'data/pi-runs'), file).replaceAll('\\', '/').slice(0, 10).replaceAll('/', '-');
    }
    const key = path.relative(root, file).replaceAll('\\', '/');
    const { usage, evidence, dates } = parseUsage(await readFile(file, 'utf8'), { date, fallbackDate });
    if (dates.length ? !dates.includes(date) : fallbackDate !== date) { delete ledger.runs[key]; continue; }
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
  ledger.scope = '仅Insight的Pi制作与测试，按事件实际北京时间归属（无时间戳的旧日志回退刊期），含补刊及失败运行；缓存/本地拦截不计联网次数，快照副本排除。不含普通飞书聊天，金额/credits未经供应商账单确认。';
  await saveJson(ledgerFile, ledger);
  return ledger;
}
export function costText(ledger, count) {
  const t = ledger.total; const n = x => x.toLocaleString('en-US');
  return `见微每日用量｜${ledger.date}\n日报：${count ? `已发布${count}条` : '尚未发布'}\nToken合计：${n(t.totalTokens)}${t.incomplete ? '（统计不完整，至少）' : ''}\n输入 ${n(t.input)} · 输出 ${n(t.output)}\n缓存读取 ${n(t.cacheRead)} · 缓存写入 ${n(t.cacheWrite)}\n搜索 ${t.search}次 · 网页读取 ${t.fetch}次\nCredits / 金额：未知（未接入供应商计费规则）\n含当日制作、测试和失败尝试；不含普通机器人聊天。${t.incomplete ? '\n部分旧日志无用量，不能视为零消耗。' : ''}\n发送“日报”获取附件。`;
}
async function authorizeFeishu(directory, request) {
  const config = JSON.parse((await readFile(path.join(directory, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const owner = await readJson(path.join(directory, 'owner.json'));
  if (!owner.chatId || !owner.openId) throw new Error('未绑定飞书收件人');
  const response = await request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }), signal: AbortSignal.timeout(30000) });
  const auth = await response.json();
  if (!response.ok || auth.code !== 0 || !auth.tenant_access_token) throw new Error('飞书日报认证失败');
  return { owner, request, headers: { Authorization: `Bearer ${auth.tenant_access_token}` } };
}

async function notifyCosts(root, ledger, deliveryKey, { editionDate, count, getClient }) {
  const file = path.join(root, 'data/delivery-ledger', `${deliveryKey}-cost.json`);
  const record = await readJson(file, { date: ledger.date, uuid: randomUUID(), status: 'pending', attempts: 0 });
  if (record.status === 'sent') return 'already-sent';
  const text = costText(ledger, count) + (editionDate && editionDate !== ledger.date ? `\n今天尚未出刊，本次附上昨天（${editionDate}）的日报。` : '');
  const { owner, headers, request } = await getClient();
  record.attempts++; record.status = 'sending'; record.lastAttempt = new Date().toISOString();
  await saveJson(file, record);
  try {
    const response = await request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ receive_id: owner.chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: record.uuid }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) throw new Error('飞书用量通知未确认成功');
    record.status = 'sent'; record.messageId = data.data?.message_id; record.sentAt = new Date().toISOString();
  } catch (e) { record.status = 'uncertain'; throw e; }
  finally { await saveJson(file, record); }
  return 'sent';
}
async function notifyDaily(root, date, deliveryKey, { editionDate, getClient }) {
  const file = path.join(root, 'data/delivery-ledger', `${deliveryKey}-daily.json`);
  const record = await readJson(file, { date, uuid: randomUUID(), status: 'pending', attempts: 0 });
  if (record.status === 'sent' && record.editionDate === editionDate && (record.kind === 'file' || !editionDate)) return 'already-sent';
  if (record.editionDate !== editionDate || (editionDate && record.kind === 'text')) {
    record.uuid = randomUUID(); delete record.fileKey;
  }
  const attachment = editionDate ? await prepareDailyAttachment(root, editionDate) : null;
  record.editionDate = editionDate;
  const { owner, headers, request } = await getClient();
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
export async function deliverDailyReport(root, { requestId, now = new Date(), request = fetch, bridgeDirectory = path.join(os.homedir(), '.pi/feishu-bridge') } = {}) {
  const release = await acquireLock(path.join(root, 'data/runtime/report-delivery.lock'));
  try {
    const date = chinaDate(now);
    const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
    const yesterday = chinaDate(new Date(now.getTime() - 86400000));
    const editionDate = state.published[date] ? date : state.published[yesterday] ? yesterday : null;
    let client;
    const delivery = { editionDate, count: state.published[date]?.count, getClient: () => client ||= authorizeFeishu(bridgeDirectory, request) };
    const key = requestId ? `${date}-request-${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}` : date;
    const costKey = !requestId && state.published[date] ? `${date}-published` : key;
    const ledger = await updateLedger(root, date);
    const result = {}; const errors = [];
    try { result.cost = await notifyCosts(root, ledger, costKey, delivery); } catch (e) { errors.push(e.message); }
    try { result.daily = await notifyDaily(root, date, key, delivery); } catch (e) { errors.push(e.message); }
    if (errors.length) throw new Error(errors.join('；'));
    return result;
  } finally { await release(); }
}

// Explicit operator-requested historical resend; normal scheduling is unchanged.
export async function redeliverDailyReports(root, editionDates, { now = new Date(), request = fetch, bridgeDirectory = path.join(os.homedir(), '.pi/feishu-bridge') } = {}) {
  if (!Array.isArray(editionDates) || !editionDates.length) throw new Error('请指定需要补发的刊期');
  const dates = [...new Set(editionDates)];
  const release = await acquireLock(path.join(root, 'data/runtime/report-delivery.lock'));
  try {
    const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
    // Validate the entire request and prepare exact archives before any send.
    for (const date of dates) {
      shiftDate(date, 0);
      if (date > chinaDate(now) || !state.published[date]) throw new Error('补发刊期尚未发布：' + date);
      await prepareDailyAttachment(root, date);
    }
    let client;
    const getClient = () => client ||= authorizeFeishu(bridgeDirectory, request);
    const results = [], errors = [];
    for (const date of dates) {
      try {
        const previous = await readJson(path.join(root, 'data/delivery-ledger', `${date}-daily.json`), null);
        if (previous && !(previous.status === 'sent' && previous.kind === 'file' && previous.editionDate === date)) {
          await saveJson(path.join(root, 'data/delivery-ledger/history', `${date}-${randomUUID()}.json`), { archivedAt: new Date().toISOString(), reason: 'operator-requested historical attachment resend', previous });
        }
        results.push({ date, status: await notifyDaily(root, date, date, { editionDate: date, getClient }) });
      } catch (error) { errors.push(date + '：' + error.message); }
    }
    if (errors.length) throw new Error('部分补发未确认成功：' + errors.join('；'));
    return results;
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
