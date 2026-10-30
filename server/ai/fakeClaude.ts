// A stand-in for the Agent SDK's query(), for the e2e server only
// (AI_FAKE_CLAUDE=1). It answers like Claude would, from the prompt text, so
// the Settings flows and an AI-named upload can be tested without credentials.
// A secret ending in "bad0" acts as a rejected sign-in.
import type { SDKMessage, SDKUserMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from './claudeRunner';

export function createFakeClaudeQuery(): QueryFn {
  let sheet = 100;
  return async function* fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): AsyncGenerator<SDKMessage> {
    let text = '';
    let images = 0;
    for await (const m of prompt) {
      const c = m.message.content;
      text += typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join('\n');
      if (typeof c !== 'string') images += c.filter(b => b.type === 'image').length;
    }
    const env = options?.env ?? {};
    const secret = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '';
    const base = { uuid: crypto.randomUUID(), session_id: 'fake' } as const;
    if (secret.endsWith('bad0')) {
      yield { ...base, type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, message: {} as any } as SDKMessage;
      yield { ...base, type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' } as unknown as SDKMessage;
      return;
    }
    let answer: string;
    if (/"sheetNumber"/.test(text)) {
      // A sheet number and title in the PDF text ("A-201 EXTERIOR ELEVATIONS")
      // are read back; otherwise pages count up from A-101 as "Floor Plan".
      // The title says whether the detail images came along with the page.
      const found = /\b([A-Z]{1,2}-\d{3})\s+([A-Z][A-Z ]*?(?:PLAN|ELEVATIONS|SECTIONS|DETAILS))\b/.exec(text);
      const sheetNumber = found ? found[1] : `A-${++sheet}`;
      const title = found ? found[2].toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Floor Plan';
      const sheetTitle = images >= 5 ? title : `${title} (no detail)`;
      answer = JSON.stringify({ sheetNumber, sheetTitle, discipline: 'Architectural', confidence: 0.95, setNotes: 'Sheet number large in the title block.' });
    } else if (/"matchSheetId"/.test(text)) {
      answer = JSON.stringify({ matchSheetId: 'new', confidence: 0.9, reason: 'fake' });
    } else if (/"text"/.test(text)) {
      answer = JSON.stringify({ text: 'A-101', confidence: 0.9 });
    } else {
      answer = '{"ok": true}';
    }
    // Like a subscription: the plan's limits with each call, then the call's token use.
    const now = Math.floor(Date.now() / 1000);
    yield { ...base, type: 'rate_limit_event', rate_limit_info: {
      status: 'allowed', rateLimitType: 'five_hour', resetsAt: now + 7200,
      unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: now + 7200, status: 'allowed' }, seven_day: { utilization: 0.12, resetsAt: now + 3 * 86400, status: 'allowed' } },
    } } as unknown as SDKMessage;
    const model = options?.model ?? 'claude-opus-5-5';
    yield {
      ...base, type: 'result', subtype: 'success', is_error: false, result: answer,
      modelUsage: { [model]: { inputTokens: 15000, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.068 } },
    } as unknown as SDKMessage;
  };
}
