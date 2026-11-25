import path from 'node:path';
import { readJson } from './runtime.mjs';
import { validatePiBundle } from './pi-contract.mjs';

export function bundleWriteRestriction(event, folder) {
  if (!['write', 'edit'].includes(event.toolName)) return;
  if (typeof event.input?.path !== 'string' || path.resolve(event.input.path) !== path.resolve(folder, 'bundle.json')) {
    return { block: true, reason: `本次制作只允许write/edit指定稿件：${path.join(folder, 'bundle.json')}。` };
  }
  if (event.toolName === 'edit') return { block: true, reason: '稿件JSON禁止文本替换，避免重叠、歧义与语法损坏。请用insight_update_bundle按字段事务式修改；空operations取得revision后再read文件，提交set/remove操作。' };
  if (event.toolName === 'write') {
    try { JSON.parse(event.input.content); }
    catch { return { block: true, reason: 'write内容不是合法JSON，原文件未修改。首次写入须为合法JSON；已有稿件优先使用insight_update_bundle修改字段。' }; }
  }
}

export async function bundleWriteFeedback(event, folder) {
  if (!['write', 'edit'].includes(event.toolName) || event.isError || typeof event.input?.path !== 'string') return;
  const output = path.join(folder, 'bundle.json');
  if (path.resolve(event.input.path) !== path.resolve(output)) return;
  const options = await readJson(path.join(folder, 'validation.json'), null);
  if (!options) return;
  try {
    const bundle = await readJson(output);
    validatePiBundle(bundle, options);
    return { content: [...event.content, { type: 'text', text: `本地发布校验通过：${bundle.issue.stories.length}条。文件已保存，正式发布由外层程序完成。` }], isError: false };
  } catch (error) {
    return { content: [{ type: 'text', text: `文件已保存，但尚未通过发布校验：\n${error.message}\n请在本次运行内修复；已有文件使用insight_update_bundle按JSON字段修改，先用空operations取得revision再read文件，直至validationPassed=true。只修有证据的问题，不伪造查询、URL或引文；确实无法修复则明确报告失败。` }], isError: true };
  }
}
