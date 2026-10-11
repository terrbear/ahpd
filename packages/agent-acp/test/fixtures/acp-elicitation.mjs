import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
let output;
const send = (message) => {
  const line = `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
  if (output) output.push(line);
  else process.stdout.write(line);
};
const flush = () => {
  process.stdout.write(output.join(""));
  output = undefined;
};
let capabilities;
let prompt;
let pending;
let finished = false;
const update = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId: "fixture-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (process.env.ACP_LOG) appendFileSync(process.env.ACP_LOG, `${line}\n`);
  if (m.method === "initialize") {
    capabilities = m.params.clientCapabilities;
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fixture", version: "1" },
      },
    });
  } else if (m.method === "session/new")
    send({ id: m.id, result: { sessionId: "fixture-session" } });
  else if (m.method === "session/prompt") {
    prompt = m.id;
    const text = m.params.prompt[0].text;
    if (text === "crash") process.exit(1);
    if (text === "expire") {
      send({ method: "$/cancel_request", params: { requestId: pending } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (text === "interrupt") {
      update(
        "The interruption is visible; the earlier question remains pending.",
      );
      send({ id: m.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (!capabilities?.elicitation?.form) {
      update("input unsupported: no form elicitation capability");
      send({ id: m.id, result: { stopReason: "end_turn" } });
      return;
    }
    output = [];
    pending = "ask-1";
    send({
      id: pending,
      method: "elicitation/create",
      params: {
        sessionId:
          text === "wrong-session" ? "another-session" : "fixture-session",
        toolCallId: "async-call",
        mode: text === "unsupported" ? "_unknown" : "form",
        message: "Codex needs your input to continue.",
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              title: "Use an isolated worktree?",
              oneOf: [
                { const: "Yes", title: "Yes" },
                { const: "Pause", title: "Pause" },
              ],
              _meta: { codex: { isOther: true } },
            },
            ...(text === "single"
              ? {}
              : {
                  note: { type: "string", title: "Additional answer or note" },
                }),
          },
          required: ["choice"],
        },
      },
    });
    update(
      'functions.request_user_input_async returned {"accepted":true}; continuing independent investigation.',
    );
    send({
      method: "session/update",
      params: {
        sessionId: "fixture-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-only",
          title: "Read repository",
          kind: "read",
          rawInput: { path: "/tmp" },
        },
      },
    });
    update("Independent investigation complete.");
    if (["async", "single"].includes(text)) {
      finished = true;
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }
    flush();
  } else if (m.method === "session/cancel") {
    finished = true;
    send({ id: prompt, result: { stopReason: "cancelled" } });
  } else if (m.id === pending) {
    update(`answer=${JSON.stringify(m.result ?? m.error)}`);
    if (prompt && !finished)
      send({ id: prompt, result: { stopReason: "end_turn" } });
  }
});
