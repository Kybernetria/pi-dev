import type { WorkerOutput, WorkerRequest } from "../types.ts";
import { hasBaseOutput, isRecord, isStringArray, type AgentDefinition } from "../runtime/definition.ts";
import { loadAgentPrompt } from "../runtime/prompts.ts";

export const workerDefinition: AgentDefinition<WorkerRequest, WorkerOutput> = {
  role: "worker",
  description: "Implementation worker with direct cwd mutation",
  builtinTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  defaultThinkingLevel: "medium",
  systemPrompt: loadAgentPrompt("worker"),
  outputContract: `{"summary":"string","changedFiles":[{"path":"string","change":"string"}],"tests":[{"command":"string","status":"passed|failed|skipped","output":"string"}],"unresolvedIssues":["string"],"diagnostics":["string"],"message":"human-readable summary"}`,
  buildTaskDetails: (request) => ({
    plan: request.plan ?? [],
    acceptanceCriteria: request.acceptanceCriteria ?? [],
  }),
  validateOutput: (value): value is WorkerOutput => hasBaseOutput(value)
    && typeof value.summary === "string"
    && Array.isArray(value.changedFiles) && value.changedFiles.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.change === "string")
    && Array.isArray(value.tests) && value.tests.every(isTestResult)
    && isStringArray(value.unresolvedIssues),
};

function isTestResult(value: unknown): boolean {
  return isRecord(value)
    && typeof value.command === "string"
    && (value.status === "passed" || value.status === "failed" || value.status === "skipped")
    && typeof value.output === "string";
}
