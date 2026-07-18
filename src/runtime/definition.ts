import type { AgentRequestBase } from "../types.ts";

export type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export type AgentRole = "scout" | "architect" | "worker" | "reviewer" | "security_reviewer";

export interface AgentDefinition<Request extends AgentRequestBase, Output> {
  role: AgentRole;
  description: string;
  systemPrompt: string;
  builtinTools: readonly BuiltinToolName[];
  customToolNames?: readonly string[];
  defaultModel?: string;
  defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  outputContract: string;
  validateOutput(value: unknown): value is Output;
  buildTaskDetails(request: Request): Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function hasBaseOutput(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isStringArray(value.diagnostics) && typeof value.message === "string";
}
