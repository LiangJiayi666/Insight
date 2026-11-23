import { SearchGuard } from '../src/search-guard.mjs';
import path from 'node:path';
import { bundleWriteFeedback, bundleWriteRestriction } from '../src/pi-feedback.mjs';
import { readJson } from '../src/runtime.mjs';
export default function(pi: any) {
  const folder = process.env.INSIGHT_SEARCH_CACHE;
  if (!folder) return;
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
