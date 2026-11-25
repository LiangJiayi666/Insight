import { SearchGuard } from '../src/search-guard.mjs';
import path from 'node:path';
import { bundleWriteFeedback, bundleWriteRestriction } from '../src/pi-feedback.mjs';
import { readJson } from '../src/runtime.mjs';
import { Type } from '@earendil-works/pi-ai';
import { patchBundle, bundleRevision } from '../src/bundle-patch.mjs';
export default function(pi: any) {
  const folder = process.env.INSIGHT_SEARCH_CACHE;
  if (!folder) return;
  pi.registerTool({
    name: 'insight_update_bundle', label: '修改日报JSON字段',
    description: '事务式修改本次bundle.json。先用空operations取得revision，再read稿件，用返回的revision提交非空operations。path为字段名/数组索引字符串数组；set的valueJson为合法JSON字符串；remove删除字段或数组元素（多个元素从大索引向小索引删除）。所有操作按顺序执行，任一操作失败不写盘；自动保存合法JSON并返回完整发布校验。不接受文件路径。',
    parameters: Type.Object({ revision: Type.String(), operations: Type.Array(Type.Object({ op: Type.Union([Type.Literal('set'), Type.Literal('remove')]), path: Type.Array(Type.String()), valueJson: Type.Optional(Type.String()) })) }),
    async execute(_id: string, params: any) {
      try {
        const result = params.operations.length ? await patchBundle(path.dirname(folder), params) : { revision: await bundleRevision(path.dirname(folder)) };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error: any) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
    },
  });
  const guard = new SearchGuard(folder, { ...JSON.parse(process.env.INSIGHT_EXA_POLICY || '{}'), rejectConcurrent: true, ...(process.env.INSIGHT_EXA_RATE_LIMIT_STATE ? { rateLimitFile: process.env.INSIGHT_EXA_RATE_LIMIT_STATE } : {}) });
  pi.on('before_agent_start', async () => {
    const options = await readJson(path.join(path.dirname(folder), 'validation.json'), null);
    if (options?.requireSelection === false) { guard.maxSearch = 4; guard.maxFetch = 3; guard.maxCalls = 7; }
  });
  pi.on('tool_call', async (event: any) => {
    const restriction = bundleWriteRestriction(event, path.dirname(folder));
    if (restriction) return restriction;
    if (!/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName)) return;
    return guard.before(event.toolCallId, event.toolName, event.input);
  });
  pi.on('tool_result', async (event: any) => {
    const result = await guard.after(event.toolCallId, { content: event.content, details: event.details, structuredContent: event.structuredContent, isError: event.isError });
    if (/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName)) return { content: [...event.content, { type: 'text', text: [await guard.budget(), await guard.policyStatus()].filter(Boolean).join('\n') }], details: result?.details || event.details, structuredContent: event.structuredContent };
    return bundleWriteFeedback(event, path.dirname(folder));
  });
}
