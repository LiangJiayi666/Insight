import { SearchGuard } from '../src/search-guard.mjs';
export default function(pi: any) {
  const folder = process.env.INSIGHT_SEARCH_CACHE;
  if (!folder) return;
  const guard = new SearchGuard(folder);
  pi.on('tool_call', async (event: any) => {
    if (!/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName)) return;
    return guard.before(event.toolCallId, event.toolName, event.input);
  });
  pi.on('tool_result', async (event: any) => {
    await guard.after(event.toolCallId, { content: event.content, details: event.details, structuredContent: event.structuredContent, isError: event.isError });
  });
}
