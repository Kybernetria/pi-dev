import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProtocolInvocationContext } from "@kybernetria/pi-protocol";
import type { AgentOutputBase, AgentRequestBase, ThinkingLevel } from "../types.ts";
import type { AgentDefinition } from "./definition.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
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
  runner: ChildAgentRunner;
  baseCwd?: string;
  maxPromptChars?: number;
  maxResponseChars?: number;
}

export async function runAgent<Request extends AgentRequestBase, Output extends AgentOutputBase>(
  definition: AgentDefinition<Request, Output>,
  request: Request,
  context: ProtocolInvocationContext | undefined,
  dependencies: RunAgentDependencies,
): Promise<Output> {
  validateBaseRequest(request);
  const cwd = await resolveCwd(request.cwd, dependencies.baseCwd ?? process.cwd());
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const diagnostics: string[] = [];
  const externalSignal = context?.abortSignal;
  const abortFromCaller = () => controller.abort(externalSignal?.reason ?? createAbortError("Invocation cancelled"));
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = setTimeout(() => controller.abort(createAbortError(`Agent timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();

  try {
    const promptLimit = dependencies.maxPromptChars ?? envPositiveInt("PI_DEV_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS);
    const promptData = {
      task: request.task,
      context: request.context ?? "",
      cwd,
      roleDetails: definition.buildTaskDetails(request),
      outputContract: definition.outputContract,
    };
    const serialized = JSON.stringify(promptData, null, 2);
    const promptTruncation = truncate(serialized, promptLimit);
    if (promptTruncation.truncated) diagnostics.push(`Model prompt was truncated to ${promptLimit} characters.`);
    const prompt = `Complete this request. Return only valid JSON matching outputContract.\n${promptTruncation.text}\n${promptTruncation.truncated ? `[DIAGNOSTIC: input was truncated at ${promptLimit} characters; report this in diagnostics.]` : ""}`;

    const configuredThinking = request.thinkingLevel
      ?? parseThinking(process.env[`PI_DEV_${definition.role.toUpperCase()}_THINKING`])
      ?? parseThinking(process.env.PI_DEV_THINKING)
      ?? definition.defaultThinkingLevel;
    const configuredModel = request.model ?? process.env[`PI_DEV_${definition.role.toUpperCase()}_MODEL`] ?? process.env.PI_DEV_MODEL;

    const raw = await raceWithAbort(dependencies.runner({
      role: definition.role,
      cwd,
      prompt,
      systemPrompt: definition.systemPrompt,
      builtinTools: definition.builtinTools,
      customToolNames: definition.customToolNames ?? [],
      ...(configuredModel ? { model: configuredModel } : {}),
      thinkingLevel: configuredThinking,
      signal: controller.signal,
    }), controller.signal);

    const responseLimit = dependencies.maxResponseChars ?? envPositiveInt("PI_DEV_MAX_RESPONSE_CHARS", DEFAULT_MAX_RESPONSE_CHARS);
    if (raw.length > responseLimit) {
      throw new Error(`Agent output exceeded ${responseLimit} characters and was truncated; structured output cannot be trusted.`);
    }
    const parsed = parseJsonObject(raw);
    if (!definition.validateOutput(parsed)) throw new Error(`${definition.role} agent returned malformed structured output`);
    if (diagnostics.length > 0) {
      parsed.diagnostics.push(...diagnostics);
      parsed.message = `${parsed.message} (${diagnostics.join(" ")})`;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
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
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* handled below */ }
    }
    throw new Error("Agent returned invalid JSON");
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? createAbortError("Aborted"));
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason ?? createAbortError("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}
