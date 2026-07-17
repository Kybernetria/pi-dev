import type { ArchitectOutput, ArchitectRequest } from "../types.ts";
import { hasBaseOutput, isRecord, isStringArray, type AgentDefinition } from "../runtime/definition.ts";
import { loadAgentPrompt } from "../runtime/prompts.ts";

export const architectDefinition: AgentDefinition<ArchitectRequest, ArchitectOutput> = {
  role: "architect",
  description: "Read-only software architect",
  builtinTools: ["read", "grep", "find", "ls"],
  defaultThinkingLevel: "high",
  systemPrompt: loadAgentPrompt("architect"),
  outputContract: `{"summary":"string","assumptions":["string"],"plan":[{"order":1,"action":"string","rationale":"string"}],"risks":[{"risk":"string","mitigation":"string"}],"acceptanceCriteria":["string"],"diagnostics":["string"],"message":"human-readable summary"}`,
  buildTaskDetails: (request) => ({
    constraints: request.constraints ?? [],
    outputDepth: request.outputDepth ?? "standard",
  }),
  validateOutput: (value): value is ArchitectOutput => hasBaseOutput(value)
    && typeof value.summary === "string"
    && isStringArray(value.assumptions)
    && Array.isArray(value.plan) && value.plan.every((step) => isRecord(step) && Number.isInteger(step.order) && typeof step.action === "string" && typeof step.rationale === "string")
    && Array.isArray(value.risks) && value.risks.every((risk) => isRecord(risk) && typeof risk.risk === "string" && typeof risk.mitigation === "string")
    && isStringArray(value.acceptanceCriteria),
};
