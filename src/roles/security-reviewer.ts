import type { SecurityReviewerOutput, SecurityReviewerRequest } from "../types.ts";
import { hasBaseOutput, isRecord, isStringArray, type AgentDefinition } from "../runtime/definition.ts";
import { loadAgentPrompt } from "../runtime/prompts.ts";

const severities = new Set(["blocker", "high", "medium", "low", "info"]);
const exploitabilityLevels = new Set(["none", "low", "medium", "high"]);

export const securityReviewerDefinition: AgentDefinition<SecurityReviewerRequest, SecurityReviewerOutput> = {
  role: "security_reviewer",
  description: "Source-read-only security reviewer with constrained git/test execution",
  builtinTools: ["read", "grep", "find", "ls"],
  customToolNames: ["review_command"],
  defaultThinkingLevel: "high",
  systemPrompt: loadAgentPrompt("security-reviewer"),
  outputContract: `{"summary":"string","verdict":"approve|request_changes|blocked","threatModel":[{"asset":"string","threat":"string","mitigation":"string"}],"findings":[{"severity":"blocker|high|medium|low|info","area":"string","file":"string","line":1,"exploitability":"none|low|medium|high","explanation":"string","recommendedFix":"string"}],"testResults":[{"command":"string","status":"passed|failed|skipped","output":"string"}],"diagnostics":["string"],"message":"human-readable summary"}`,
  buildTaskDetails: (request) => ({
    suppliedDiff: request.diff,
    commit: request.commit,
    range: request.range,
    acceptanceCriteria: request.acceptanceCriteria ?? [],
    testExpectations: request.testExpectations ?? [],
    securityFocus: request.securityFocus ?? [],
  }),
  validateOutput: (value): value is SecurityReviewerOutput => hasBaseOutput(value)
    && typeof value.summary === "string"
    && (value.verdict === "approve" || value.verdict === "request_changes" || value.verdict === "blocked")
    && Array.isArray(value.threatModel) && value.threatModel.every((threat) => isRecord(threat)
      && typeof threat.asset === "string" && typeof threat.threat === "string" && typeof threat.mitigation === "string")
    && Array.isArray(value.findings) && value.findings.every((finding) => isRecord(finding)
      && typeof finding.severity === "string" && severities.has(finding.severity)
      && typeof finding.area === "string" && typeof finding.file === "string"
      && (finding.line === undefined || Number.isInteger(finding.line))
      && typeof finding.exploitability === "string" && exploitabilityLevels.has(finding.exploitability)
      && typeof finding.explanation === "string" && typeof finding.recommendedFix === "string")
    && Array.isArray(value.testResults) && value.testResults.every((result) => isRecord(result)
      && typeof result.command === "string"
      && (result.status === "passed" || result.status === "failed" || result.status === "skipped")
      && typeof result.output === "string"),
};
