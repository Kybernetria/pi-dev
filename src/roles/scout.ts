import type { ScoutOutput, ScoutRequest } from "../types.ts";
import { hasBaseOutput, isRecord, isStringArray, type AgentDefinition } from "../runtime/definition.ts";
import { loadAgentPrompt } from "../runtime/prompts.ts";

export const scoutDefinition: AgentDefinition<ScoutRequest, ScoutOutput> = {
  role: "scout",
  description: "Fast read-only codebase exploration agent",
  builtinTools: ["read", "grep", "find", "ls"],
  defaultThinkingLevel: "minimal",
  systemPrompt: loadAgentPrompt("scout"),
  outputContract: `{"summary":"string","files":[{"path":"string","line":1,"relevance":"string"}],"codePaths":[{"from":"string","to":"string","relationship":"string"}],"findings":["string"],"unresolvedQuestions":["string"],"diagnostics":["string"],"message":"concise human-readable findings"}`,
  buildTaskDetails: (request) => ({
    scope: request.scope ?? [],
    questions: request.questions ?? [],
  }),
  validateOutput: (value): value is ScoutOutput => hasBaseOutput(value)
    && typeof value.summary === "string"
    && Array.isArray(value.files) && value.files.every((file) => isRecord(file)
      && typeof file.path === "string"
      && (file.line === undefined || Number.isInteger(file.line))
      && typeof file.relevance === "string")
    && Array.isArray(value.codePaths) && value.codePaths.every((codePath) => isRecord(codePath)
      && typeof codePath.from === "string"
      && typeof codePath.to === "string"
      && typeof codePath.relationship === "string")
    && isStringArray(value.findings)
    && isStringArray(value.unresolvedQuestions),
};
