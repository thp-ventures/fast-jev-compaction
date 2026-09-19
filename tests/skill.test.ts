import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, plan, run } from '../skills/jev-compact/scripts/compact.mjs';

const temps: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function work() {
  return { goal: 'Continue without repeating the migration', preserveRecentMessages: 0,
    protectedToolUseIds: ['receipt'], messages: [
      { role: 'user', text: 'Do not deploy', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [
        { tool_use_id: 'old', tool: 'Read', input: {} },
        { tool_use_id: 'receipt', tool: 'Bash', input: {} },
      ] },
      { role: 'user', text: '', toolUses: [], toolResults: [
        { tool_use_id: 'old', text: 'obsolete '.repeat(1000) },
        { tool_use_id: 'receipt', text: 'Receipt R-17, never repeat' },
      ] },
    ] };
}
const response = (body: any) => ({ answers: Object.fromEntries(Object.keys(body.questions).map(q => [q, { type: 'noul', noul: 0 }])) });
function output() { const path = mkdtempSync(join(tmpdir(), 'jev-skill-test-')); temps.push(path); return join(path, 'bundle'); }

describe('standalone Codex skill', () => {
  it('uses the protected original engine and rejects changed plans or malformed scores', async () => {
    const p = await plan(work());
    const responses = p.requests.map(response);
    const result = await apply(p, responses);
    expect(result.messages[2].toolResults.map((r: any) => r.tool_use_id)).toEqual(['receipt']);
    responses[0].answers.call_t1.noul = 2;
    await expect(apply(p, responses)).rejects.toThrow('Invalid Jev probability');
    p.requests[0].state.goal = 'tampered';
    await expect(apply(p, p.requests.map(response))).rejects.toThrow('Plan changed');
  });

  it('archives the exact original and full retained evidence with private file permissions', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-only-placeholder');
    const p = await plan(work()), dir = output();
    const report = await run(p, dir, async (body: any) => response(body));
    expect(report.status).toBe('compacted');
    expect(report.byteReduction).toBeGreaterThan(0.5);
    expect(JSON.parse(readFileSync(join(dir, 'original.json'), 'utf8'))).toEqual(work());
    expect(statSync(join(dir, 'original.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const send = vi.fn();
    await expect(run(p, dir, send)).rejects.toThrow('already exists');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps everything on request failure without exposing transport error text', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-only-placeholder');
    const p = await plan(work()), dir = output();
    const report = await run(p, dir, async () => { throw Error('private transport details'); });
    expect(report.status).toBe('fallback_kept_all');
    expect(JSON.stringify(report)).not.toContain('private transport details');
    expect(JSON.parse(readFileSync(join(dir, 'compacted.json'), 'utf8'))).toEqual(work());
  });

  it('rejects duplicate IDs and orphan results before planning', async () => {
    const source = work();
    source.messages[1].toolUses!.push(source.messages[1].toolUses![0]!);
    await expect(plan(source)).rejects.toThrow('unique');
    const orphan = work();
    orphan.messages[2].toolResults![0]!.tool_use_id = 'unknown';
    await expect(plan(orphan)).rejects.toThrow('Unpaired');
  });
});
