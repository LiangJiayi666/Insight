import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Timestamps come from Pi's tool-result envelope, never from article content
// or the model's historical issue date. Keep the latest successful real fetch.
export function collectSourceAccessTimes(text, times = new Map()) {
  const calls = new Map();
  for (const line of text.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'tool_execution_start' && event.toolName === 'mcp__exa__web_fetch_exa') {
      calls.set(event.toolCallId, event.args?.urls || []);
    }
    const message = event.message;
    if (event.type !== 'message_end' || message?.role !== 'toolResult' || message.toolName !== 'mcp__exa__web_fetch_exa' || message.isError) continue;
    if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) continue;
    for (const url of calls.get(message.toolCallId) || []) {
      if (typeof url !== 'string') continue;
      const previous = times.get(url);
      if (!previous || Date.parse(previous) < message.timestamp) times.set(url, new Date(message.timestamp).toISOString());
    }
  }
  return times;
}

export async function alignSourceAccessTimes(issue, folder) {
  const times = new Map();
  const files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const file of files.filter(name => /^attempt-\d+\.private\.log$/.test(name))) {
    collectSourceAccessTimes(await readFile(path.join(folder, file), 'utf8'), times);
  }
  const updates = [];
  for (const source of issue.sources) {
    const actual = times.get(source.url);
    if (actual && source.accessed !== actual) {
      updates.push({ id: source.id, before: source.accessed, after: actual });
      source.accessed = actual;
    }
  }
  return updates;
}
