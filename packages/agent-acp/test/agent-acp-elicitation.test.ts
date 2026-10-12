import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acpSession } from "../src/session.js";
import type { Bag, Session } from "@ahpd/sdk";

const fixture = fileURLToPath(
  new URL("./fixtures/acp-elicitation.mjs", import.meta.url),
);
const live: Session[] = [];
const paths: string[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.close();
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true });
});
const until = async (
  check: () => boolean,
  detail: () => unknown = () => undefined,
) => {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check(), JSON.stringify(detail())).toBe(true);
};
function start() {
  const path = mkdtempSync(join(tmpdir(), "ahpd-async-input-"));
  paths.push(path);
  const log = join(path, "acp.jsonl");
  const events: { where: string; action: Bag }[] = [];
  const session = acpSession(
    {
      command: process.execPath,
      args: [fixture],
      env: { ACP_LOG: log },
      hostTools: false,
    },
    {
      uri: `acp:/${path}`,
      chatUri: `ahp-chat:/${path}`,
      workingDirectory: "/tmp",
      settings: {},
      schema: () => ({}),
      emit: (where, action) => events.push({ where, action }),
    },
  );
  live.push(session);
  return { session, events, log };
}

it("publishes accepted async questions before turn completion and retains them through progress and interruption", async () => {
  const { session, events, log } = start();
  session.begin("turn-async", "async");
  await until(() => events.some((e) => e.action.type === "chat/turnComplete"));
  const asked = events.find((e) => e.action.type === "chat/inputRequested");
  expect(asked, readFileSync(log, "utf8")).toBeDefined();
  expect(asked?.where).toBe("chat");
  const request = asked?.action.request as Bag;
  expect(request.questions).toMatchObject([
    {
      title: "Use an isolated worktree?",
      options: [{ label: "Yes" }, { label: "Pause" }],
      allowFreeformInput: true,
    },
    { title: "Additional answer or note", kind: "text" },
  ]);
  expect(
    events.findIndex((e) => e.action.type === "chat/inputRequested"),
  ).toBeLessThan(
    events.findIndex((e) => e.action.type === "chat/turnComplete"),
  );
  expect(
    events.some((e) => e.action.type === "session/inputNeededRemoved"),
  ).toBe(false);
  const pending = events.find((e) => e.action.type === "session/inputNeededSet")?.action.request;
  expect(session.sessionState()).toMatchObject({ inputNeeded: [pending] });
  session.begin("turn-interrupt", "interrupt");
  await until(
    () =>
      events.filter((e) => e.action.type === "chat/turnComplete").length === 2,
  );
  session.answer(String(request.id), true, {
    choice: {
      state: "submitted",
      value: {
        kind: "selected",
        value: "",
        freeformValues: ["Use another folder"],
      },
    },
    note: {
      state: "submitted",
      value: { kind: "text", value: "Keep the original untouched" },
    },
  });
  await until(() =>
    events.some((e) => e.action.type === "session/inputNeededRemoved"),
  );
  await until(() => readFileSync(log, "utf8").includes("Use another folder"));
  expect(readFileSync(log, "utf8")).toContain("Keep the original untouched");
  expect(session.sessionState()).toMatchObject({ inputNeeded: [] });
  const state = session.chatState() as Bag;
  const origin = (state.turns as Bag[]).find(
    (turn) => turn.id === "turn-async",
  )!;
  const held = (origin.responseParts as Bag[]).find(
    (part) => part.kind === "inputRequest",
  );
  expect(held).toMatchObject({
    response: "accept",
    request: { id: request.id, answers: { choice: { state: "submitted" } } },
  });
  expect(
    events.find((e) => e.action.type === "chat/inputCompleted")?.action,
  ).toMatchObject({
    turnId: "turn-async",
    requestId: request.id,
    response: "accept",
  });
});

for (const text of ["unsupported", "wrong-session"]) {
  it(`explicitly rejects ${text} elicitation instead of creating an invisible accepted request`, async () => {
    const { session, events, log } = start();
    session.begin("turn-rejected", text);
    await until(() =>
      events.some((e) => e.action.type === "chat/turnComplete"),
    );
    expect(events.some((e) => e.action.type === "chat/inputRequested")).toBe(
      false,
    );
    const messages = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Bag);
    const failed = messages.find((m) => m.id === "ask-1");
    expect(failed?.error).toBeDefined();
    expect(JSON.stringify(failed)).toMatch(
      /Unsupported ACP elicitation mode|does not belong to this active session/,
    );
  });
}

it("rejects answers sent to another session and keeps invalid answers pending", async () => {
  const first = start();
  const second = start();
  first.session.begin("turn-first", "async");
  second.session.begin("turn-second", "async");
  await until(
    () =>
      first.events.some((e) => e.action.type === "chat/inputRequested") &&
      second.events.some((e) => e.action.type === "chat/inputRequested"),
    () => ({
      first: first.events,
      second: second.events,
      logs: [readFileSync(first.log, "utf8"), readFileSync(second.log, "utf8")],
    }),
  );
  const request = first.events.find(
    (e) => e.action.type === "chat/inputRequested",
  )!.action.request as Bag;
  expect(() => second.session.answer(String(request.id), true, {})).toThrow(
    "no longer pending",
  );
  expect(() => first.session.answer(String(request.id), true, {})).toThrow(
    "requires an answer",
  );
  expect(
    first.events.some((e) => e.action.type === "session/inputNeededRemoved"),
  ).toBe(false);
  first.session.answer(String(request.id), true, {
    choice: { state: "submitted", value: { kind: "selected", value: "Yes" } },
  });
  await until(() =>
    readFileSync(first.log, "utf8").includes('"content":{"choice":"Yes"}'),
  );
  expect(
    second.events.some((e) => e.action.type === "session/inputNeededRemoved"),
  ).toBe(false);
});

it("cancels the question and removes its card when the originating turn is stopped", async () => {
  const { session, events, log } = start();
  session.begin("turn-cancel", "pending");
  await until(() =>
    events.some((e) => e.action.type === "chat/inputRequested"),
  );
  session.cancel("turn-cancel");
  await until(() => events.some((e) => e.action.type === "chat/turnCancelled"));
  expect(
    events.find((e) => e.action.type === "chat/inputCompleted")?.action,
  ).toMatchObject({ turnId: "turn-cancel", response: "cancel" });
  expect(
    events.some((e) => e.action.type === "session/inputNeededRemoved"),
  ).toBe(true);
  await until(() => readFileSync(log, "utf8").includes('"action":"cancel"'));
});

it("retires a single async question when Codex cancels its native request", async () => {
  const { session, events } = start();
  session.begin("turn-expiring", "single");
  await until(() => events.some((e) => e.action.type === "chat/turnComplete"));
  const request = events.find((e) => e.action.type === "chat/inputRequested")!
    .action.request as Bag;
  expect(request.questions).toHaveLength(1);
  session.begin("turn-expire", "expire");
  await until(() =>
    events.some((e) => e.action.type === "session/inputNeededRemoved"),
  );
  expect(
    events.find((e) => e.action.type === "chat/inputCompleted")?.action,
  ).toMatchObject({
    turnId: "turn-expiring",
    requestId: request.id,
    response: "cancel",
  });
  expect(() => session.answer(String(request.id), true, {})).toThrow(
    "no longer pending",
  );
});

it("removes an earlier async question when the ACP connection is lost during a later turn", async () => {
  const { session, events } = start();
  session.begin("turn-original", "single");
  await until(() => events.some((e) => e.action.type === "chat/turnComplete"));
  const request = events.find((e) => e.action.type === "chat/inputRequested")!
    .action.request as Bag;
  session.begin("turn-crash", "crash");
  await until(() => events.some((e) => e.action.type === "chat/error"));
  expect(
    events.find((e) => e.action.type === "chat/inputCompleted")?.action,
  ).toMatchObject({
    turnId: "turn-original",
    requestId: request.id,
    response: "cancel",
  });
  expect(
    events.some((e) => e.action.type === "session/inputNeededRemoved"),
  ).toBe(true);
  expect(() => session.answer(String(request.id), true, {})).toThrow(
    "no longer pending",
  );
});
