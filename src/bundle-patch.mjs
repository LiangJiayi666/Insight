import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWrite, readJson, acquireLock } from './runtime.mjs';
import { validatePiBundle } from './pi-contract.mjs';

const revisionOf = text => createHash('sha256').update(text).digest('hex');
export async function patchBundle(folder, { revision, operations }) {
  const release = await acquireLock(path.join(folder, 'bundle-patch.lock'));
  try { return await applyPatch(folder, { revision, operations }); }
  finally { await release(); }
}

async function applyPatch(folder, { revision, operations }) {
  const file = path.join(folder, 'bundle.json');
  const original = await readFile(file, 'utf8');
  const currentRevision = revisionOf(original);
  if (revision !== currentRevision) throw new Error(`稿件已变化；先read bundle.json并使用revision=${currentRevision}，不要按旧数组位置修改。`);
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new Error('operations须为1至100项');
  const bundle = JSON.parse(original);
  for (const operation of operations) {
    if (!['set', 'remove'].includes(operation.op) || !Array.isArray(operation.path) || !operation.path.length) throw new Error('操作须含op=set/remove及非空path数组');
    if (!['issue', 'evidence', 'selectionAudit'].includes(operation.path[0])) throw new Error('仅可修改稿件、证据和选题记录');
    if (operation.path.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('字段路径不合法');
    let parent = bundle;
    for (const key of operation.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('路径不存在：' + operation.path.join('/'));
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('父字段不是对象或数组');
    const key = operation.path.at(-1);
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > parent.length || (operation.op === 'remove' && Number(key) === parent.length)) throw new Error('数组索引无效');
      if (operation.op === 'remove') parent.splice(Number(key), 1);
      else parent[Number(key)] = JSON.parse(operation.valueJson);
    } else if (operation.op === 'remove') {
      if (!Object.hasOwn(parent, key)) throw new Error('待删除字段不存在');
      delete parent[key];
    } else parent[key] = JSON.parse(operation.valueJson);
  }
  const options = await readJson(path.join(folder, 'validation.json'));
  // The model may build in stages, but cannot rewrite the edition or its window.
  if (bundle.issue?.date !== options.date || bundle.issue?.cutoff !== options.window.end) throw new Error('禁止修改刊期或截止时间');
  const updated = JSON.stringify(bundle, null, 2) + '\n';
  let validationError;
  try { validatePiBundle(bundle, options); } catch (error) { validationError = error.message; }
  await atomicWrite(file, updated);
  return { revision: revisionOf(updated), validationPassed: !validationError, validationError, count: bundle.issue.stories?.length || 0 };
}

export async function bundleRevision(folder) {
  return revisionOf(await readFile(path.join(folder, 'bundle.json'), 'utf8'));
}
