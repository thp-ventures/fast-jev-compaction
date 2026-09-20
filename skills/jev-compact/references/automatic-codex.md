# Automatic Codex checkpoints

The plugin runs a synchronous `PreCompact` hook and a `Stop` hook that immediately
detaches its own background worker. The wrapper works on Codex versions that do
not yet accept the native `async` hook field.
Both read Codex's `transcript_path`, export only visible user/assistant messages
and paired tool exchanges, and write a recoverable Jev bundle under the plugin's
private `PLUGIN_DATA/checkpoints/<session-id>/` directory.

The exporter excludes developer messages and reasoning records. It strips common
injected environment/skill blocks, redacts likely credentials, protects probable
write or publication calls, preserves detected errors, refuses transcripts over
25 MB, deduplicates unchanged histories, and silently keeps the original when
Jev or parsing fails. A second scan refuses the checkpoint if credential-shaped
text remains after redaction.

`PreCompact` always checkpoints a changed tool-bearing transcript. `Stop` waits
until the transcript reaches 150,000 bytes and has grown by 75,000 bytes since
the last successful checkpoint. Advanced users may change those thresholds with
`JEV_COMPACT_STOP_MIN_BYTES` and `JEV_COMPACT_GROWTH_BYTES`.

Read `status.json` for the latest outcome and `state.json` for the latest bundle
path. Each bundle contains `original.json`, `compacted.json`, `responses.json`,
and `report.json`. The hook never injects the compacted export into the same
task, because Codex's hook API cannot replace live messages and adding the export
would increase context.

The Codex transcript format is documented as unstable. Unsupported formats fail
closed with `unsupported_or_no_tool_history`; update the exporter rather than
guessing at missing fields.
