# Selected provider debug logs

`initialize._meta["ahpd.providerDebugLogs"]` advertises
`{"version":1,"maxBytes":20971520}`. A diagnostic client can call the existing
`vscode/collectAgentHostDebugLogs` method with exactly:

```json
{"version":1,"providerOnly":true,"kind":"archive","session":"codex:/SESSION","chat":"ahp-chat:/CHAT"}
```

The host requires an exact known session and its exact chat. The normal
`diagnostics:read` gate still applies. On hosts with users, a non-root caller
must also own that session. No path, directory, provider override, child-session
expansion, or daemon-log selection is accepted in this mode.

The reply echoes `version`, `session`, `chat`, and `provider`. An unavailable
reply has `status:"unavailable"` and a bounded reason: `missing`, `unsupported`,
`unreadable`, `oversized`, `changed`, `invalid-log`, or `source-unavailable`.
`source-unavailable` means the provider could not resolve a native log path; it
does not prove that the underlying file is missing. An included reply adds
`status:"included"`, `coverage:"snapshot"`, `nativeSessionId`, and the existing
collection fields (`kind`, `resource`, `size`, `uncompressedSize`, `entries`,
`providerLogsIncluded`). Its only ZIP entry is `events.jsonl`.

Read the issued archive with `vscode/readAgentHostDebugLogsChunk`, passing its
`resource` and a byte `position`. Chunks contain base64 `data` and `eof`. A
provider-only archive belongs to the connection that collected it. An unrelated
connection cannot read it, even if it learns the resource. Existing ten-minute
leases apply. At most four provider archives per connection can be pending.

Claude uses the provider's existing native state-file lookup. Codex uses the
pinned ACP adapter's advertised `readOnlyHistory` version 1 operation. Its
`_session/read_history` reply must identify the exact native thread; the path
comes from the app-server's `Thread.path`. The session-tree `sessionId` is not
the thread identity. Older adapters, empty or oversized history, missing paths,
and unavailable native IDs omit the raw log. There is no filesystem search or
path inference for Codex.

The collector reads at most 20 MiB from a regular, non-symlink file, verifies the
native identity in the JSONL, and rejects files that change during the read.
Invalid JSONL, including an incomplete last record, is omitted. It copies the
bounded snapshot into private staging and exports no partial raw log.

These are raw sensitive provider records. The transport does not redact them.
The receiving diagnostic bundle must apply its redaction and private transfer
controls. Redaction cannot guarantee that conversation content is secret-free.
Coverage is one native chat snapshot, not all historical replacements or child
chats. Synthetic tests exercise both provider formats and transport isolation;
they do not prove a physical provider installation supports the feature.
