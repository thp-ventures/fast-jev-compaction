#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compact} from './engine/compact.js';

const MODEL = 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});

function key() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  const path = join(homedir(), '.config/jev/api-key');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

export function validate(work) {
  if (!work || typeof work.goal !== 'string' || !work.goal.trim() || !Array.isArray(work.messages)) {
    throw Error('Input needs a nonempty goal and messages array');
  }
  const calls = new Set(), results = new Set();
  for (const message of work.messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' ||
        !Array.isArray(message.toolUses) || (message.toolResults !== undefined && !Array.isArray(message.toolResults))) {
      throw Error('Messages need original user/assistant roles, text, and toolUses arrays');
    }
    for (const [items, ids, isCall] of [[message.toolUses, calls, true], [message.toolResults ?? [], results, false]]) {
      for (const item of items) {
        if (!item || typeof item.tool_use_id !== 'string' || !item.tool_use_id || ids.has(item.tool_use_id)) throw Error('Tool IDs must be unique nonempty strings');
        ids.add(item.tool_use_id);
        if (isCall ? typeof item.tool !== 'string' || !item.input || typeof item.input !== 'object' || Array.isArray(item.input) : typeof item.text !== 'string') throw Error('Invalid tool call/result');
        if (isCall && item.text !== undefined && typeof item.text !== 'string') throw Error('Tool text must be a string');
        for (const flag of ['isError', 'replaySafe']) if (item[flag] !== undefined && typeof item[flag] !== 'boolean') throw Error('Tool flags must be booleans');
      }
    }
  }
  for (const id of results) if (!calls.has(id)) throw Error('Unpaired tool result');
  if (work.protectedToolUseIds !== undefined && (!Array.isArray(work.protectedToolUseIds) || work.protectedToolUseIds.some(id => typeof id !== 'string'))) throw Error('protectedToolUseIds must be an array of native IDs');
  const recent = work.preserveRecentMessages ?? 12;
  if (!Number.isSafeInteger(recent) || recent < 0) throw Error('preserveRecentMessages must be a nonnegative integer');
  return {goal: work.goal, protectedToolUseIds: work.protectedToolUseIds ?? [], preserveRecentMessages: recent};
}

export async function plan(work) {
  const options = validate(work), requests = [];
  await compact(work.messages, {ask: async (state, questions) => {
    requests.push({model: MODEL, state, questions});
    return {answers: Object.fromEntries(Object.keys(questions).map(q => [q, {type: 'noul', noul: 1}]))};
  }}, options);
  return {version: 1, source: work, sourceSha256: hash(work), requests,
          requestBytes: requests.reduce((n, body) => n + Buffer.byteLength(JSON.stringify(body)), 0)};
}

async function checkPlan(value) {
  if (JSON.stringify(value) !== JSON.stringify(await plan(value.source))) throw Error('Plan changed or uses a different engine; regenerate it');
}

export async function apply(value, responses) {
  await checkPlan(value);
  if (!Array.isArray(responses) || responses.length !== value.requests.length) throw Error('Missing response batches');
  for (let i = 0; i < responses.length; i++) {
    const answers = responses[i]?.answers, expected = Object.keys(value.requests[i].questions).sort();
    if (!answers || JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(expected)) throw Error('Unexpected answer IDs');
    for (const q of expected) {
      const a = answers[q];
      if (!a || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw Error('Invalid Jev probability');
    }
  }
  let index = 0;
  return compact(value.source.messages, {ask: async () => responses[index++]}, validate(value.source));
}

export async function run(value, output, send) {
  await checkPlan(value);
  if (existsSync(output)) throw Error('Output already exists; choose a new directory');
  if (value.requestBytes > 2_000_000 || value.requests.length > 100) throw Error('Plan exceeds the live budget (2 MB / 100 requests)');
  const credential = value.requests.length ? key() : '';
  if (value.requests.length && !credential) throw Error('Jev key not configured; do not paste it into chat');
  mkdirSync(output, {recursive: true, mode: 0o700});
  write(join(output, 'original.json'), value.source);
  const responses = [];
  let result, error = null;
  try {
    // Keep response order even with four requests in flight. No retries.
    for (let i = 0; i < value.requests.length; i += 4) {
      const batch = await Promise.allSettled(value.requests.slice(i, i + 4).map(body => send(body, credential)));
      for (const outcome of batch) {
        if (outcome.status === 'fulfilled') responses.push(outcome.value);
      }
      if (batch.some(r => r.status === 'rejected')) throw Error('Jev request failed; original retained, no automatic retries');
    }
    result = await apply(value, responses);
  } catch {
    error = 'Jev request or validation failed; original retained';
    result = {messages: value.source.messages, decisions: [], stats: null};
  }
  const outputWork = {...value.source, messages: result.messages};
  const before = Buffer.byteLength(JSON.stringify(value.source));
  const after = Buffer.byteLength(JSON.stringify(outputWork));
  const report = {status: error ? 'fallback_kept_all' : 'compacted', error,
    sourceSha256: value.sourceSha256, model: MODEL, requests: value.requests.length,
    originalBytes: before, compactedBytes: after, byteReduction: 1 - after / before,
    tokenSavings: 'Not measured; this does not shrink active Codex history',
    usage: responses.map(r => r.usage ?? null), decisions: result.decisions, stats: result.stats};
  write(join(output, 'compacted.json'), outputWork);
  write(join(output, 'responses.json'), {planSha256: hash(value), responses});
  write(join(output, 'report.json'), report);
  return report;
}

async function send(body, credential) {
  const response = await fetch(ENDPOINT, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: {Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!response.ok) throw Error('Jev HTTP request failed');
  return response.json();
}

export async function main(args) {
  if (args.length === 1 && args[0] === 'status') {
    console.log(JSON.stringify({engine: 'improved-fast-jev-compaction', model: MODEL, keyConfigured: Boolean(key())}));
  } else if (args.length === 3 && args[0] === 'plan') {
    const value = await plan(read(args[1]));
    write(args[2], value);
    console.log(JSON.stringify({requests: value.requests.length, requestBytes: value.requestBytes, networkCalls: 0}));
  } else if (args.length === 4 && args[0] === 'run' && args[3] === '--send-to-jev') {
    const report = await run(read(args[1]), args[2], send);
    console.log(JSON.stringify({status: report.status, byteReduction: report.byteReduction, error: report.error}));
    if (report.error) process.exitCode = 2;
  } else throw Error('Usage: compact.mjs status | plan work.json plan.json | run plan.json new-output-dir --send-to-jev');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {console.error('Compaction failed: check input, key configuration, and output path; no credentials are logged.'); process.exitCode = 1;});
}
