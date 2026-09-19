import { describe, expect, it } from 'vitest';
import { applyDecisions, collectToolCalls, compact, type JevAsker, type Message } from '../src/index.js';

function transcript(): Message[] {
  return [
    { role: 'user', text: 'Continue the migration without repeating writes.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'receipt', tool: 'Bash', input: { command: 'migrate' }, replaySafe: false },
      { tool_use_id: 'obsolete', tool: 'Read', input: {} },
      { tool_use_id: 'mapping', tool: 'Read', input: {} },
      { tool_use_id: 'failure', tool: 'Bash', input: {} },
    ] },
    { role: 'user', text: '', toolUses: [], toolResults: [
      { tool_use_id: 'receipt', text: 'committed receipt R-198; do not repeat' },
      { tool_use_id: 'obsolete', text: 'old listing' },
      { tool_use_id: 'mapping', text: 'x'.repeat(2000) + 'unique mapping account=external_id' },
      { tool_use_id: 'failure', text: 'failed on row 917', isError: true },
    ] },
    { role: 'assistant', text: 'Continue', toolUses: [] },
  ];
}

function dropEverything(seen: string[]): JevAsker {
  return { async ask(_state, questions) {
    seen.push(...Object.keys(questions));
    return { answers: Object.fromEntries(Object.keys(questions).map(q => [q, { type: 'noul', noul: 0 }])) };
  } };
}

describe('protected tool results', () => {
  it('retains complete marked pairs without asking Jev, even in a rebuilt multi-call message', async () => {
    const messages = transcript();
    const original = structuredClone(messages);
    const seen: string[] = [];
    const output = await compact(messages, dropEverything(seen), {
      preserveRecentMessages: 0, protectedToolUseIds: ['mapping'],
    });
    expect(seen).toEqual(['call_t2', 'result_t2']);
    expect(output.stats).toMatchObject({ requests: 1, pinned: 3, callsDropped: 1 });
    expect(output.messages[1]?.toolUses).toEqual(messages[1]!.toolUses.filter(t => t.tool_use_id !== 'obsolete'));
    expect(output.messages[2]?.toolResults).toEqual(messages[2]!.toolResults!.filter(t => t.tool_use_id !== 'obsolete'));
    expect(output.messages[2]?.toolResults?.[1]).toBe(messages[2]!.toolResults![2]);
    expect(messages).toEqual(original);
  });

  it('enforces pins at apply time even with an externally supplied drop decision', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0, { protectedToolUseIds: ['mapping'] });
    const decisions = calls.filter(c => c.pinned).map(c => ({
      id: c.id, tool: c.tool, action: 'drop_call' as const, reason: 'call_dropped' as const,
      keepCall: 0, keepResult: 0,
    }));
    expect(applyDecisions(messages, decisions, calls, 0)).toEqual(messages);
  });

  it('supports result-side replay safety and either error location, with an explicit resolved-error opt-out', () => {
    const messages = transcript();
    delete messages[1]!.toolUses[0]!.replaySafe;
    messages[2]!.toolResults![0]!.replaySafe = false;
    messages[1]!.toolUses[1]!.isError = true;
    expect(collectToolCalls(messages, 0)[1]?.isError).toBe(true);
    expect(collectToolCalls(messages, 0).map(c => c.pinned)).toEqual([true, true, false, true]);
    expect(collectToolCalls(messages, 0, { preserveErrors: false }).map(c => c.pinned)).toEqual([true, false, false, false]);
  });

  it('rejects a misspelled protected ID before any request and accepts IDs of unfinished calls', async () => {
    const seen: string[] = [];
    await expect(compact(transcript(), dropEverything(seen), {
      protectedToolUseIds: ['typo'],
    })).rejects.toThrow('Unknown protected tool_use_id: typo');
    expect(seen).toEqual([]);
    const messages = transcript();
    messages[1]!.toolUses.push({ tool_use_id: 'pending', tool: 'Bash', input: {} });
    expect(() => collectToolCalls(messages, 0, { protectedToolUseIds: ['pending'] })).not.toThrow();
  });

  it('does not call Jev when every pair is protected', async () => {
    const messages = transcript();
    const seen: string[] = [];
    const output = await compact(messages, dropEverything(seen), {
      preserveRecentMessages: 0, protectedToolUseIds: ['mapping', 'obsolete'],
    });
    expect(seen).toEqual([]);
    expect(output.messages).toEqual(messages);
    expect(output.stats.requests).toBe(0);
  });
});
