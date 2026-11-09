import type { ChatEvent } from "../provider.interface.ts";
import { ASYNC_QUESTION_TOOL, type ChatQuestion } from "../../shared/chat-questions.ts";
import type { ToolRequestUserInputResponse } from "./codex-protocol.ts";

export function normalizeCodexQuestions(value: unknown): ChatQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const question = typeof value.question === "string" ? value.question : value.title;
    if (typeof question !== "string" || !question.trim()) return [];
    const options = Array.isArray(value.options) ? value.options.flatMap((option: unknown) => {
      if (typeof option === "string") return [{ label: option }];
      if (!option || typeof option !== "object" || !("label" in option) || typeof option.label !== "string") return [];
      return [{ label: option.label, ...("description" in option && typeof option.description === "string" ? { description: option.description } : {}) }];
    }) : [];
    return [{ id: typeof value.id === "string" ? value.id : String(index), question,
      ...(typeof value.header === "string" ? { header: value.header } : {}), options }];
  });
}

export function codexAsyncQuestionEvent(item: Record<string, unknown>): ChatEvent | null {
  if (item.type !== "agentMessage" && item.type !== "AgentMessage") return null;
  const questions = normalizeCodexQuestions(item.questions);
  if (typeof item.id !== "string" || !questions.length) return null;
  return { type: "tool_use", tool: ASYNC_QUESTION_TOOL, toolUseId: item.id, input: { questions } };
}

export function buildUserInputResponse(questions: unknown, data: unknown): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse["answers"] = {};
  if (!data || typeof data !== "object") return { answers };
  normalizeCodexQuestions(questions).forEach((question, index) => {
    const id = question.id!;
    const value = Array.isArray(data) ? data[index]
      : Object.hasOwn(data, id) ? (data as Record<string, unknown>)[id]
      : Object.hasOwn(data, question.question) ? (data as Record<string, unknown>)[question.question] : undefined;
    if (value != null) Object.defineProperty(answers, id, {
      value: { answers: Array.isArray(value) ? value.map(String) : [String(value)] }, enumerable: true,
    });
  });
  return { answers };
}
