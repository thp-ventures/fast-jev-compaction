# Explicit protection check — 19 September 2026

This checks a retention API, not automatic detection of important facts. The
caller supplies native IDs or replay-safety metadata. No extra model pass is
added. Unmarked critical outputs can still be lost.

| Case | Implementation | Median API seconds | Median output bytes removed | Input tokens/run | Critical record losses over 3 runs |
|---|---|---:|---:|---:|---:|
| buried_mapping | original | 0.791 | 75.4% | 4,223 | 6/6 |
| buried_mapping | improved | 0.744 | 66.4% | 4,025 | 0/6 |
| action_receipt | original | 0.743 | 71.0% | 4,239 | 3/6 |
| action_receipt | improved | 0.705 | 64.9% | 4,041 | 0/6 |

Every run used one request. The improvement comes from deterministic protection
and corrected judging instructions, not better discovery of hidden facts.
Keeping critical outputs intentionally reduces the achievable compression.
The baseline lost both designated mapping records in every run and the receipt
in every migration run; it retained the error-tagged failure. The improved
version preserved all four designated records in every run. It also chose to
truncate some obsolete outputs rather than delete their calls, so whole-record
removal and byte reduction differ (see the raw JSON).

## Method

- Baseline: tamaratran/fast-jev-compaction at e3f262a7f4d42bd8dd32ced30d26176f7cb545b0, executed with Node type stripping. Improved version built with TypeScript.
- Model: jev-1.13.0. Same Python HTTP transport. Three repeats, alternating execution order. API time excludes preparation and local replay. No retries.
- Fixtures: `buried_mapping` and `action_receipt` from [the frozen synthetic generator](https://github.com/thp-ventures/jev-compact/blob/21e392e/experiments/evaluate_hybrid.py), 24 tool exchanges each. Both retain the last 12 native messages (six pairs).
- Mapping: supply `protectedToolUseIds: ['r3', 'r11']`. Migration: set the r4 tool call's `replaySafe` to false and the r10 result's `isError` to true. Both versions receive the same annotated messages/options; the original does not implement the new protection fields.
- All other options are defaults; goal is the fixture's explicit goal. Raw measurements are in `protection.json`. Total: 140,322 outgoing request bytes, 49,584 reported input tokens, below the 300 KB cap. No private task histories were sent.

This is a small API verification using previously seen synthetic cases, not a
held-out accuracy benchmark or proof of general speed/cost improvements. The
input usage is about 5% lower in these runs because protected calls need no
questions and the judging instructions are shorter. Byte reduction is not
measured model-context token savings or actual Codex billing savings.

## Verification

`npm test`: all 34 tests pass. `npm run typecheck` (library and hooks) and
`npm run build` pass. Tests cover mixed multi-call messages, complete payload
retention, result-side and call-side protection, unknown IDs, unfinished calls,
zero-request compaction, and enforcement of pins in `applyDecisions`.

`npm run validate:plugin` fails with `hooks: Invalid input: expected record,
received undefined`. Running the same validator on the untouched baseline
produces the identical error. The installed Claude runtime has not been verified
with this function-hook plugin; library and hook unit tests do not establish a
working native installation. Built-in fallback summarization is outside the
library's retention guarantee.
