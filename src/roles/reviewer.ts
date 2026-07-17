import type { ReviewerOutput, ReviewerRequest } from "../types.ts";
import { hasBaseOutput, isRecord, type AgentDefinition } from "../runtime/definition.ts";
import { loadAgentPrompt } from "../runtime/prompts.ts";

const severities = new Set(["blocker", "high", "medium", "low", "info"]);

export const reviewerDefinition: AgentDefinition<ReviewerRequest, ReviewerOutput> = {
  role: "reviewer",
  description: "Source-read-only code reviewer with constrained git/test execution",
  builtinTools: ["read", "grep", "find", "ls"],
  customToolNames: ["review_command"],
  defaultThinkingLevel: "high",
  systemPrompt: loadAgentPrompt("reviewer"),
  outputContract: `{"summary":"string","verdict":"approve|request_changes|blocked","findings":[{"severity":"blocker|high|medium|low|info","file":"string","line":1,"explanation":"string","recommendedFix":"string"}],"testResults":[{"command":"string","status":"passed|failed|skipped","output":"string"}],"diagnostics":["string"],"message":"human-readable summary"}`,
  buildTaskDetails: (request) => ({
    suppliedDiff: request.diff,
    commit: request.commit,
    range: request.range,
    acceptanceCriteria: request.acceptanceCriteria ?? [],
    testExpectations: request.testExpectations ?? [],
  }),
  validateOutput: (value): value is ReviewerOutput => hasBaseOutput(value)
    && typeof value.summary === "string"
    && (value.verdict === "approve" || value.verdict === "request_changes" || value.verdict === "blocked")
    && Array.isArray(value.findings) && value.findings.every((finding) => isRecord(finding)
      && typeof finding.severity === "string" && severities.has(finding.severity)
      && typeof finding.file === "string"
      && (finding.line === undefined || Number.isInteger(finding.line))
      && typeof finding.explanation === "string"
      && typeof finding.recommendedFix === "string")
    && Array.isArray(value.testResults) && value.testResults.every((result) => isRecord(result)
      && typeof result.command === "string"
      && (result.status === "passed" || result.status === "failed" || result.status === "skipped")
      && typeof result.output === "string"),
};
