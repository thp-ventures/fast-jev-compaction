#!/usr/bin/env node
/** Automatic, fail-closed Codex transcript exporter and Jev sidecar checkpoint. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {plan, run} from '../skills/jev-compact/scripts/compact.mjs';

const DEFAULT_STOP_MIN_BYTES = 150_000;
const DEFAULT_GROWTH_BYTES = 75_000;
const MAX_TRANSCRIPT_BYTES = 25_000_000;
const SECRET_TEXT = [
  {pattern: /-----BEGIN ((?:RSA |OPENSSH |EC )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    replacement: '[REDACTED PRIVATE KEY]'},
  {pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: '[REDACTED API KEY]'},
  {pattern: /\bBearer\s+[A-Za-z0-9._~-]{16,}/gi, replacement: 'Bearer [REDACTED TOKEN]'},
  {pattern: /(\b(?:api[_-]?key|token|secret)\s*[:=]\s*)["'][^$<{\s][^"']{7,}["']/gi,
    replacement: '$1"[REDACTED]"'},
];
const MUTATION_HINT = /\b(apply_patch|write_stdin|git\s+(?:add|commit|push|reset|merge)|gh\s+pr\s+(?:create|merge|close)|(?:create|update|delete|remove|send|publish|deploy|install|uninstall|archive|rename)_[a-z_]+)\b/i;
const STRIP_BLOCKS = [
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,
  /<skill>[\s\S]*?<\/skill>/gi,
];

const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};

function textContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && ['input_text', 'output_text'].includes(item.type) && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}

function cleanUserText(text) {
  let output = text;
  for (const pattern of STRIP_BLOCKS) output = output.replace(pattern, '');
  if (/^# AGENTS\.md instructions\b/.test(output.trim())) return '';
  return output.trim();
}

function objectInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {value};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {value: parsed};
  } catch {
    return {raw: value};
  }
}

function outputText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return '[unserializable tool output]'; }
}

function redactString(value, count) {
  let output = value;
  for (const {pattern, replacement} of SECRET_TEXT) {
    pattern.lastIndex = 0;
    const matches = output.match(pattern);
    count.value += matches?.length ?? 0;
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  return output;
}

function redactValue(value, count) {
  if (typeof value === 'string') return redactString(value, count);
  if (Array.isArray(value)) return value.map(item => redactValue(item, count));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, count)]));
  }
  return value;
}

function likelyError(text) {
  return /\b(?:isError["']?\s*:\s*true|exit_code["']?\s*:\s*[1-9]\d*|script failed|traceback|uncaught error)\b/i.test(text);
}

function stripEmpty(messages) {
  return messages.filter(message => message.text || message.toolUses.length || message.toolResults?.length);
}

export function exportTranscript(raw) {
  const messages = [];
  const calls = new Map();
  const protectedToolUseIds = new Set();
  const seen = new Set();
  let recognized = 0;
  const redactions = {value: 0};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') continue;
    const item = record.payload;
    const itemId = typeof item.id === 'string' ? item.id : '';
    if (itemId && seen.has(itemId)) continue;
    if (itemId) seen.add(itemId);
    if (item.type === 'message' && ['user', 'assistant'].includes(item.role)) {
      let text = textContent(item.content);
      if (item.role === 'user') text = cleanUserText(text);
      text = redactString(text, redactions);
      if (text) messages.push({role: item.role, text, toolUses: []});
      recognized++;
      continue;
    }
    if (['custom_tool_call', 'function_call'].includes(item.type) && typeof item.call_id === 'string') {
      const input = redactValue(objectInput(item.input ?? item.arguments), redactions);
      const encodedInput = JSON.stringify(input);
      const tool = typeof item.name === 'string' ? item.name : 'tool';
      const use = {tool_use_id: item.call_id, tool, input};
      if (MUTATION_HINT.test(`${tool} ${encodedInput}`)) {
        use.replaySafe = false;
        protectedToolUseIds.add(item.call_id);
      }
      calls.set(item.call_id, use);
      messages.push({role: 'assistant', text: '', toolUses: [use]});
      recognized++;
      continue;
    }
    if (['custom_tool_call_output', 'function_call_output'].includes(item.type) &&
        typeof item.call_id === 'string' && calls.has(item.call_id)) {
      const text = redactString(outputText(item.output), redactions);
      const result = {tool_use_id: item.call_id, text};
      if (likelyError(text)) {
        result.isError = true;
        protectedToolUseIds.add(item.call_id);
      }
      messages.push({role: 'user', text: '', toolUses: [], toolResults: [result]});
      recognized++;
    }
  }
  const cleaned = stripEmpty(messages);
  const userTexts = cleaned.filter(m => m.role === 'user' && m.text).map(m => m.text);
  const goal = userTexts.at(-1)?.slice(0, 4000) || 'Preserve the current task state for a later continuation.';
  return {recognized, redactions: redactions.value, work: {goal, protectedToolUseIds: [...protectedToolUseIds],
    preserveRecentMessages: 12, messages: cleaned}};
}

export function containsLikelySecret(work) {
  const body = JSON.stringify(work);
  return SECRET_TEXT.some(({pattern}) => {
    pattern.lastIndex = 0;
    return pattern.test(body);
  });
}

export function shouldCheckpoint({event, bytes, previousBytes = 0, sameHash = false}) {
  if (sameHash || bytes <= 0 || bytes > MAX_TRANSCRIPT_BYTES) return false;
  if (event === 'PreCompact') return true;
  if (event !== 'Stop') return false;
  const minimum = numberEnv('JEV_COMPACT_STOP_MIN_BYTES', DEFAULT_STOP_MIN_BYTES);
  const growth = numberEnv('JEV_COMPACT_GROWTH_BYTES', DEFAULT_GROWTH_BYTES);
  return bytes >= minimum && bytes - previousBytes >= growth;
}

function safeId(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
}

function writeAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, value, {mode: 0o600});
  renameSync(temp, path);
}

function recordStatus(root, value) {
  mkdirSync(root, {recursive: true, mode: 0o700});
  writeAtomic(join(root, 'status.json'), json({...value, updatedAt: new Date().toISOString()}));
}

export async function checkpoint(payload, options = {}) {
  const event = payload?.hook_event_name;
  const transcriptPath = payload?.transcript_path;
  const dataRoot = options.dataRoot ?? process.env.PLUGIN_DATA ?? join(homedir(), '.codex', 'jev-compact');
  const sessionRoot = join(dataRoot, 'checkpoints', safeId(payload?.session_id));
  if (!['PreCompact', 'Stop'].includes(event) || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    recordStatus(sessionRoot, {status: 'skipped', reason: 'missing_or_unsupported_hook_input'});
    return {status: 'skipped'};
  }
  const transcriptBytes = statSync(transcriptPath).size;
  if (!shouldCheckpoint({event, bytes: transcriptBytes})) {
    recordStatus(sessionRoot, {status: 'skipped', reason: 'outside_size_threshold'});
    return {status: 'skipped'};
  }
  const raw = readFileSync(transcriptPath, 'utf8');
  const transcriptHash = hash(raw);
  const statePath = join(sessionRoot, 'state.json');
  let prior = {};
  try { prior = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  if (!shouldCheckpoint({event, bytes: transcriptBytes, previousBytes: prior.bytes ?? 0,
    sameHash: prior.transcriptHash === transcriptHash})) {
    recordStatus(sessionRoot, {status: 'skipped', reason: 'below_threshold_or_unchanged'});
    return {status: 'skipped'};
  }
  mkdirSync(sessionRoot, {recursive: true, mode: 0o700});
  const lockPath = join(sessionRoot, 'checkpoint.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch {
    recordStatus(sessionRoot, {status: 'skipped', reason: 'checkpoint_already_running'});
    return {status: 'skipped'};
  }
  try {
    const exported = exportTranscript(raw);
    if (exported.recognized === 0 || exported.work.messages.length < 2 ||
        !exported.work.messages.some(message => message.toolUses.length)) {
      recordStatus(sessionRoot, {status: 'skipped', reason: 'unsupported_or_no_tool_history'});
      return {status: 'skipped'};
    }
    if (containsLikelySecret(exported.work)) {
      recordStatus(sessionRoot, {status: 'skipped', reason: 'possible_secret_remained_after_redaction'});
      return {status: 'skipped'};
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const entry = join(sessionRoot, `${stamp}-${event.toLowerCase()}-${transcriptHash.slice(0, 10)}`);
    mkdirSync(entry, {recursive: true, mode: 0o700});
    writeFileSync(join(entry, 'work.json'), json(exported.work), {mode: 0o600});
    const makePlan = options.planFn ?? plan;
    const execute = options.runFn ?? run;
    const value = await makePlan(exported.work);
    writeFileSync(join(entry, 'plan.json'), json(value), {mode: 0o600});
    const report = await execute(value, join(entry, 'bundle'), options.sendFn);
    writeAtomic(statePath, json({transcriptHash, bytes: transcriptBytes, latest: entry,
      status: report.status, event, updatedAt: new Date().toISOString()}));
    recordStatus(sessionRoot, {status: report.status, event, latest: entry, redactions: exported.redactions,
      originalBytes: report.originalBytes, compactedBytes: report.compactedBytes,
      byteReduction: report.byteReduction});
    return {status: report.status, entry};
  } catch {
    recordStatus(sessionRoot, {status: 'failed', reason: 'export_or_compaction_failed'});
    return {status: 'failed'};
  } finally {
    if (lock !== undefined) closeSync(lock);
    try { unlinkSync(lockPath); } catch {}
  }
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input || '{}');
}

function launchBackground(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--background', encoded], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

export async function handleHook(payload, options = {}) {
  if (payload?.hook_event_name === 'Stop' && !options.background) {
    const launch = options.launchFn ?? launchBackground;
    launch(payload);
    return {status: 'queued'};
  }
  return checkpoint(payload, options);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === '--background' && process.argv[3]) {
      const payload = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
      await handleHook(payload, {background: true});
    } else {
      await handleHook(await readStdin());
    }
  } catch {}
  process.stdout.write('{"continue":true}\n');
}
