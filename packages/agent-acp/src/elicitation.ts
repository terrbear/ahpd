import { randomUUID } from "node:crypto";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import type { Bag, Emit } from "@ahpd/sdk";
import type { AcpTurn } from "./types.js";

const bag = (value: unknown): Bag =>
  typeof value === "object" && value !== null ? (value as Bag) : {};

function questionsOf(schema: Bag): Bag[] {
  if (schema.type !== undefined && schema.type !== "object")
    throw new Error("ACP elicitation requires an object form");
  const required = Array.isArray(schema.required) ? schema.required : [];
  const entries = Object.entries(bag(schema.properties));
  if (entries.length === 0)
    throw new Error("ACP elicitation form has no supported fields");
  return entries.map(([id, raw]) => {
    const field = bag(raw);
    const type = String(field.type ?? "string");
    if (!["string", "number", "integer", "boolean", "array"].includes(type))
      throw new Error(`Unsupported ACP elicitation field ${id}: ${type}`);
    const choices = field.oneOf ?? field.enum ?? bag(field.items).enum;
    if (type === "array" && !Array.isArray(choices))
      throw new Error(
        `Unsupported ACP elicitation array ${id}: expected string choices`,
      );
    const options = Array.isArray(choices)
      ? choices.map((rawOption) => {
          const option = bag(rawOption);
          const value =
            typeof rawOption === "string" ? rawOption : option.const;
          if (typeof value !== "string")
            throw new Error(`Unsupported ACP elicitation option for ${id}`);
          return {
            id: value,
            label: typeof option.title === "string" ? option.title : value,
            ...(typeof option.description === "string"
              ? { description: option.description }
              : {}),
          };
        })
      : [];
    let kind = type === "string" ? "text" : type;
    if (options.length > 0)
      kind = type === "array" ? "multi-select" : "single-select";
    return {
      id,
      title: String(field.title ?? id),
      message: String(field.description ?? ""),
      kind,
      required: required.includes(id),
      options,
      allowFreeformInput: bag(bag(field._meta).codex).isOther === true,
    };
  });
}

export function contentOf(questions: Bag[], answers: Bag): Bag {
  const content: Bag = {};
  for (const question of questions) {
    const id = String(question.id);
    const answer = bag(answers[id]);
    if (answer.state !== "submitted") {
      if (question.required === true)
        throw new Error(`ACP elicitation field ${id} requires an answer`);
      continue;
    }
    const inner = bag(answer.value);
    const free = Array.isArray(inner.freeformValues)
      ? inner.freeformValues
      : [];
    let value = inner.value ?? answer.value;
    if (question.kind === "single-select") value = free[0] ?? value;
    if (question.kind === "multi-select")
      value = [...(Array.isArray(value) ? value : []), ...free];
    if (question.kind === "text" && typeof value !== "string")
      throw new Error(`ACP elicitation field ${id} requires text`);
    if (question.kind === "boolean" && typeof value !== "boolean")
      throw new Error(`ACP elicitation field ${id} requires a boolean`);
    if (
      ["number", "integer"].includes(String(question.kind)) &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (question.kind === "integer" && !Number.isInteger(value)))
    )
      throw new Error(
        `ACP elicitation field ${id} requires a ${String(question.kind)}`,
      );
    if (question.kind === "single-select" || question.kind === "multi-select") {
      const options = question.options as { id: string }[];
      const values = question.kind === "single-select" ? [value] : value;
      if (
        !Array.isArray(values) ||
        values.some(
          (item) =>
            typeof item !== "string" ||
            (question.allowFreeformInput !== true &&
              !options.some((option) => option.id === item)),
        )
      )
        throw new Error(
          `ACP elicitation field ${id} requires a provided choice`,
        );
    }
    content[id] = value;
  }
  return content;
}

export function elicitations(
  emit: Emit,
  chat: string,
  current: () => { sessionId: string | undefined; turn: AcpTurn | undefined },
) {
  const pending = new Map<
    string,
    {
      turn: string;
      part: Bag;
      questions: Bag[];
      settle: (response: CreateElicitationResponse) => void;
    }
  >();
  const settle = (
    id: string,
    response: CreateElicitationResponse,
    answers: Bag = {},
  ): void => {
    const held = pending.get(id);
    if (held === undefined) return;
    pending.delete(id);
    held.part.response = response.action;
    bag(held.part.request).answers = answers;
    emit("chat", {
      type: "chat/inputCompleted",
      turnId: held.turn,
      requestId: id,
      response: response.action,
      answers,
    });
    emit("session", { type: "session/inputNeededRemoved", id });
    held.settle(response);
  };
  return {
    size: (): number => pending.size,
    create: async (
      request: CreateElicitationRequest,
      signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
      if (signal.aborted) return { action: "cancel" };
      const context = current();
      if (
        !("sessionId" in request) ||
        request.sessionId !== context.sessionId ||
        context.turn === undefined
      )
        throw new Error(
          "ACP elicitation does not belong to this active session",
        );
      if (request.mode !== "form")
        throw new Error(`Unsupported ACP elicitation mode: ${request.mode}`);
      const questions = questionsOf(bag(request.requestedSchema));
      const id = `elicitation-${randomUUID()}`;
      const input = { id, message: request.message, questions };
      const part: Bag = { kind: "inputRequest", request: input };
      const turn = context.turn;
      return await new Promise((resolve) => {
        pending.set(id, {
          turn: turn.turnId,
          part,
          questions,
          settle: resolve,
        });
        const cancel = () => settle(id, { action: "cancel" });
        signal.addEventListener("abort", cancel, { once: true });
        pending.get(id)!.settle = (response) => {
          signal.removeEventListener("abort", cancel);
          resolve(response);
        };
        turn.parts.push(part);
        emit("session", {
          type: "session/inputNeededSet",
          request: { id, chat, kind: "chatInput", request: input },
        });
        emit("chat", {
          type: "chat/inputRequested",
          turnId: turn.turnId,
          request: input,
        });
      });
    },
    answer: (id: string, accepted: boolean, answers: Bag): void => {
      const held = pending.get(id);
      if (held === undefined)
        throw new Error(
          `ACP elicitation ${id} is no longer pending in ${chat}`,
        );
      if (!accepted) {
        settle(id, { action: "decline" });
        return;
      }
      const content = contentOf(held.questions, answers);
      settle(id, { action: "accept", content }, answers);
    },
    cancel: (turn?: string): void => {
      for (const [id, held] of [...pending]) {
        if (turn === undefined || held.turn === turn)
          settle(id, { action: "cancel" });
      }
    },
  };
}
