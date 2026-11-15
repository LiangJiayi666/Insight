import { classifyToolFailure } from './tool-failure.mjs';

export function diagnoseRun(text) {
  const diagnosis = { searchRateLimited: false, networkFailure: false, crawlTimeout: false, searchCooldownBlocked: false };
  for (const line of text.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); }
    catch { continue; } // Unstructured output is not evidence of a provider error.
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason === 'error') {
      diagnosis.networkFailure ||= classifyToolFailure({ isError: true, error: event.message.errorMessage }).networkFailure;
    }
    if (event.type !== 'tool_execution_end' || !/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName || '')) continue;
    const failure = classifyToolFailure({ ...event.result, isError: event.isError === true || event.result?.isError === true });
    diagnosis.searchRateLimited ||= failure.rateLimited;
    diagnosis.networkFailure ||= failure.networkFailure;
    diagnosis.crawlTimeout ||= failure.crawlTimeout;
    diagnosis.searchCooldownBlocked ||= failure.guardBlocked;
  }
  return diagnosis;
}
