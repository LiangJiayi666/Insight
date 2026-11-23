import { classifyToolFailure } from './tool-failure.mjs';

export function diagnoseRun(text) {
  const diagnosis = { searchRateLimited: false, networkFailure: false, crawlTimeout: false, searchCooldownBlocked: false };
  const providerErrors = [];
  let lastAssistant;
  let emptySearches = 0, exaCalls = 0;
  for (const line of text.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); }
    catch { continue; } // Unstructured output is not evidence of a provider error.
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      lastAssistant = event.message;
      if (lastAssistant.stopReason === 'length') diagnosis.outputTruncated = true;
      if (lastAssistant.stopReason === 'error') {
        // Pi can exit 0 even when every provider request failed. Keep this
        // separate from Exa errors and from a missing/invalid local artifact.
        const message = String(lastAssistant.errorMessage || '模型请求失败');
        const status = Number(/\b([45]\d\d)\b/.exec(message)?.[1]) || null;
        providerErrors.push({ status, message: message.slice(0, 500) });
        diagnosis.networkFailure ||= classifyToolFailure({ isError: true, error: message }).networkFailure || /timed?\s*out|timeout|\b50[234]\b/i.test(message);
      }
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'tool_search' && /No matching tools found/i.test(JSON.stringify(event.result))) emptySearches++;
    if (event.type !== 'tool_execution_end' || !/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName || '')) continue;
    exaCalls++;
    const failure = classifyToolFailure({ ...event.result, isError: event.isError === true || event.result?.isError === true });
    diagnosis.searchRateLimited ||= failure.rateLimited;
    diagnosis.networkFailure ||= failure.networkFailure;
    diagnosis.crawlTimeout ||= failure.crawlTimeout;
    diagnosis.searchCooldownBlocked ||= failure.guardBlocked;
  }
  if (providerErrors.length) diagnosis.providerErrors = providerErrors;
  if (lastAssistant?.stopReason === 'error') diagnosis.terminalProviderError = String(lastAssistant.errorMessage || '模型请求失败').slice(0, 500);
  if (emptySearches && !exaCalls) diagnosis.searchToolsUnavailable = true;
  return diagnosis;
}
