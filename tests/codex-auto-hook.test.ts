import {mkdtempSync, readFileSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  checkpoint,
  containsLikelySecret,
  exportTranscript,
  shouldCheckpoint,
} from '../plugins/jev-compact/scripts/codex-auto-compact.mjs';

const line = (payload: object) => JSON.stringify({type: 'response_item', payload});
const transcript = () => [
  line({id: 'dev', type: 'message', role: 'developer', content: [{type: 'input_text', text: 'hidden'}]}),
  line({id: 'u1', type: 'message', role: 'user', content: [{type: 'input_text', text: 'Fix the import.\n<environment_context>noise</environment_context>'}]}),
  line({id: 'r1', type: 'reasoning', summary: ['hidden reasoning']}),
  line({id: 'c1', type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: JSON.stringify({code: 'git commit -m fix'})}),
  line({id: 'o1', type: 'custom_tool_call_output', call_id: 'call-1', output: 'commit created'}),
  line({id: 'a1', type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Done.'}]}),
].join('\n');

describe('Codex automatic checkpoint hook', () => {
  it('exports visible messages and tool pairs without developer or reasoning content', () => {
    const {work} = exportTranscript(transcript());
    expect(JSON.stringify(work)).not.toContain('hidden');
    expect(JSON.stringify(work)).not.toContain('environment_context');
    expect(work.messages.flatMap(message => message.toolUses).map(tool => tool.tool_use_id)).toEqual(['call-1']);
    expect(work.protectedToolUseIds).toEqual(['call-1']);
    expect(work.goal).toBe('Fix the import.');
  });

  it('runs PreCompact once, writes private recoverable state, and deduplicates the transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-codex-hook-'));
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, transcript());
    let calls = 0;
    const runFn = async (value: any, output: string) => {
      calls++;
      const {mkdirSync, writeFileSync} = await import('node:fs');
      mkdirSync(output);
      writeFileSync(join(output, 'compacted.json'), JSON.stringify(value.source));
      return {status: 'compacted', originalBytes: 1000, compactedBytes: 400, byteReduction: 0.6};
    };
    const payload = {hook_event_name: 'PreCompact', transcript_path: path, session_id: 's1'};
    expect((await checkpoint(payload, {dataRoot: root, runFn})).status).toBe('compacted');
    expect((await checkpoint(payload, {dataRoot: root, runFn})).status).toBe('skipped');
    expect(calls).toBe(1);
    const status = JSON.parse(readFileSync(join(root, 'checkpoints/s1/status.json'), 'utf8'));
    expect(status.reason).toBe('below_threshold_or_unchanged');
  });

  it('redacts possible secrets and applies thresholds', () => {
    const raw = transcript() + '\n' + line({id: 'u2', type: 'message', role: 'user',
      content: [{type: 'input_text', text: 'token="sk-' + 'a'.repeat(20) + '"'}]});
    const exported = exportTranscript(raw);
    expect(exported.redactions).toBe(2);
    expect(JSON.stringify(exported.work)).toContain('[REDACTED');
    expect(containsLikelySecret(exported.work)).toBe(false);
    expect(shouldCheckpoint({event: 'Stop', bytes: 10_000, previousBytes: 0})).toBe(false);
    expect(shouldCheckpoint({event: 'PreCompact', bytes: 10_000, previousBytes: 0})).toBe(true);
    expect(shouldCheckpoint({event: 'PreCompact', bytes: 10_000, sameHash: true})).toBe(false);
  });

  it('skips oversized transcript files before attempting to read them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-codex-hook-large-'));
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, '');
    truncateSync(path, 25_000_001);
    const result = await checkpoint(
      {hook_event_name: 'PreCompact', transcript_path: path, session_id: 'large'},
      {dataRoot: root},
    );
    expect(result.status).toBe('skipped');
    const status = JSON.parse(readFileSync(join(root, 'checkpoints/large/status.json'), 'utf8'));
    expect(status.reason).toBe('outside_size_threshold');
  });
});
