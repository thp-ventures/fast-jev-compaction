# Export format

```json
{
  "goal": "Finish the import fix without repeating the completed migration",
  "protectedToolUseIds": ["mapping-1"],
  "preserveRecentMessages": 12,
  "messages": [
    {"role": "user", "text": "Do not deploy. Keep the vendor mapping.", "toolUses": []},
    {"role": "assistant", "text": "", "toolUses": [
      {"tool_use_id": "mapping-1", "tool": "Read", "input": {"path": "captured-mapping.json"}}
    ]},
    {"role": "user", "text": "", "toolUses": [], "toolResults": [
      {"tool_use_id": "mapping-1", "text": "Captured mapping: cust_ref=external_account_id"}
    ]},
    {"role": "assistant", "text": "", "toolUses": [
      {"tool_use_id": "migration-1", "tool": "Bash", "input": {"command": "local-migration"}, "replaySafe": false}
    ]},
    {"role": "user", "text": "", "toolUses": [], "toolResults": [
      {"tool_use_id": "migration-1", "text": "Committed receipt R-198"}
    ]}
  ]
}
```

Messages stay in chronological order. Each has original `user`/`assistant` role,
string `text`, and `toolUses` array. A result has string `text` and must refer to a
unique existing call ID. Incomplete calls remain protected by the engine's
pairing logic. Preserve multi-call messages as groups. Do not relabel system or
developer messages as user messages to fit this schema; keep them in the host's
instruction layer and outside the export.

`protectedToolUseIds` defaults to `[]`. Unknown IDs fail validation. The first
message and newest 12 messages are retained by default; `preserveRecentMessages`
can change the recent window. IDs, user/assistant text, and surviving payloads
are preserved as JSON values. Keep decisions and constraints in message text or
protect the exact result IDs that contain them. There is no automatic dependency
inference: include the IDs of supporting evidence too.

A plan embeds the source and outgoing requests. Regeneration checks reject a
changed plan. It contains no API key. Keep plan/output files outside Git or in an
ignored local directory. The bundle retains the original export; this runner
does not parse or modify Codex's private native transcript format.
