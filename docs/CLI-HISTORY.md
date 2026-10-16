# Exact CLI history reads for Anton #3735

`resourceRead` on `ahpd-cli-history://<claude|codex>/<native-uuid>?host=<hostname>&user=<numeric-uid>` returns version 1 read-only JSON for the daemon's own OS user and host. There is no write method and no authorization exemption. Existing resource grants apply unchanged. Signed-in multi-user principals are refused rather than mapped speculatively to OS ownership. Old hosts return unsupported; missing, mismatched, empty or oversized history returns unavailable, never a replacement session.

Claude requires the pinned SDK 0.3.278 and uses exact served-directory catalogue membership followed by `getSessionMessages` with `includeSystemMessages:true`. Records are returned unchanged, including supplied compaction boundaries, tool results, references and unresolved tool use. No synthetic completed state is added.

Codex requires the companion `terrbear/codex-acp` read-only extension: initialize advertises `agentCapabilities._meta.readOnlyHistory.version=1`; `_session/read_history` returns the exact thread and ordered history without new/load/resume/fork/prompt. The bridge does not use its watched-history cache, because external CLI sessions have never populated it. Unsupported adapters refuse. Reads have a 10-second bridge timeout and 8-MiB response limit; exceeding limits is unavailable rather than truncated success.

The existing adapter pin is deliberately unchanged because ahpd PR30 owns client-instruction adoption and its pin. The release owner must combine that repair with the companion history extension, review/test the exact combined revision, then update the owned pin and build/activate separately. A history-only adapter commit is not a replacement for the instruction repair. This source PR installs, configures and restarts nothing.

Writable CLI handoff is not implemented. These read contracts cannot prove authoritative release of an external writer, pending tools, or a fencing generation. An idle-looking transcript is never treated as permission to resume.
