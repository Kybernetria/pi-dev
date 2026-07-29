import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProtocolAgentSpec, ProvideSpec } from "@kybernetria/pi-protocol";
import type { AgentOutputBase, AgentRequestBase, ThinkingLevel } from "../types.ts";
import type { AgentDefinition } from "./definition.ts";

const DEFAULT_MAX_PROMPT_CHARS = 64_000;
const DEFAULT_MAX_RESPONSE_CHARS = 256_000;

export interface AgentRunnerInvocation {
  role: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  builtinTools: readonly string[];
  customToolNames: readonly string[];
  model?: string;
  thinkingLevel: ThinkingLevel;
  signal: AbortSignal;
}

export type ChildAgentRunner = (invocation: AgentRunnerInvocation) => Promise<string>;

export interface RunAgentDependencies {
  /** Test seam. Production uses the real Pi SDK session. */
  runner?: ChildAgentRunner;
  baseCwd?: string;
  maxPromptChars?: number;
  maxResponseChars?: number;
}

export interface PreparedAgentInput<Request extends AgentRequestBase = AgentRequestBase> {
  role: string;
  request: Request;
  cwd: string;
  prompt: string;
  diagnostics: string[];
  model?: string;
  thinkingLevel: ThinkingLevel;
  maxResponseChars: number;
}

export async function prepareAgentInput<Request extends AgentRequestBase, Output extends AgentOutputBase>(
  definition: AgentDefinition<Request, Output>,
  request: Request,
  agent: ProtocolAgentSpec,
  provide: ProvideSpec,
  dependencies: RunAgentDependencies,
): Promise<PreparedAgentInput<Request>> {
  validateBaseRequest(request);
  const cwd = await resolveCwd(request.cwd, dependencies.baseCwd ?? process.cwd());
  const diagnostics: string[] = [];
  const promptLimit = dependencies.maxPromptChars ?? envPositiveInt("PI_DEV_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS);
  const promptData = {
    task: request.task,
    context: request.context ?? "",
    cwd,
    roleDetails: definition.buildTaskDetails(request),
    outputContract: provide.outputSchema,
  };
  const serialized = JSON.stringify(promptData, null, 2);
  const promptTruncation = truncate(serialized, promptLimit);
  if (promptTruncation.truncated) diagnostics.push(`Model prompt was truncated to ${promptLimit} characters.`);
  const prompt = `Complete this request. Return only valid JSON matching outputContract.\n${promptTruncation.text}\n${promptTruncation.truncated ? `[DIAGNOSTIC: input was truncated at ${promptLimit} characters; report this in diagnostics.]` : ""}`;

  const thinkingLevel = request.thinkingLevel
    ?? parseThinking(process.env[`PI_DEV_${definition.role.toUpperCase()}_THINKING`])
    ?? parseThinking(process.env.PI_DEV_THINKING)
    ?? agent.modelHint?.thinkingLevel
    ?? "medium";
  const model = request.model
    ?? process.env[`PI_DEV_${definition.role.toUpperCase()}_MODEL`]
    ?? process.env.PI_DEV_MODEL
    ?? nonEmpty(agent.modelHint?.specific);

  return {
    role: definition.role,
    request,
    cwd,
    prompt,
    diagnostics,
    ...(model ? { model } : {}),
    thinkingLevel,
    maxResponseChars: dependencies.maxResponseChars ?? envPositiveInt("PI_DEV_MAX_RESPONSE_CHARS", DEFAULT_MAX_RESPONSE_CHARS),
  };
}

export function parseAgentOutput<Output extends AgentOutputBase>(
  raw: string,
  prepared: PreparedAgentInput,
): Output {
  if (raw.length > prepared.maxResponseChars) {
    throw new Error(`Agent output exceeded ${prepared.maxResponseChars} characters; structured output cannot be trusted.`);
  }
  const parsed = parseJsonObject(raw) as Output;
  if (prepared.diagnostics.length > 0) {
    if (!Array.isArray(parsed.diagnostics) || typeof parsed.message !== "string") {
      throw new Error(`${prepared.role} agent output cannot carry required truncation diagnostics`);
    }
    parsed.diagnostics.push(...prepared.diagnostics);
    parsed.message = `${parsed.message} (${prepared.diagnostics.join(" ")})`;
  }
  return parsed;
}

export async function resolveCwd(requested: string | undefined, baseCwd: string): Promise<string> {
  if (requested?.includes("\0")) throw new Error("cwd contains a NUL byte");
  const candidate = resolve(baseCwd, requested?.trim() || ".");
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new Error(`cwd does not exist: ${candidate}`);
  }
  if (!(await stat(canonical)).isDirectory()) throw new Error(`cwd is not a directory: ${canonical}`);
  return canonical;
}

function validateBaseRequest(request: AgentRequestBase): void {
  if (!request || typeof request !== "object") throw new Error("input must be an object");
  if (typeof request.task !== "string" || request.task.trim().length === 0) throw new Error("task must be a non-empty string");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch { /* handled below */ }
    }
  }
  throw new Error("Agent returned invalid JSON object");
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}
