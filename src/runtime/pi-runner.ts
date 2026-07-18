import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ChildAgentRunner } from "./run-agent.ts";
import { createReviewCommandTool } from "./review-command.ts";

const customToolFactories: Record<string, (cwd: string, signal: AbortSignal) => ToolDefinition> = {
  review_command: createReviewCommandTool,
};

export async function createPiChildAgentSession(invocation: Parameters<ChildAgentRunner>[0]): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  const model = invocation.model ? resolveModel(invocation.model, modelRuntime) : undefined;
  if (invocation.model && !model) throw new Error(`Model not found or ambiguous: ${invocation.model}`);

  const resourceLoader = new DefaultResourceLoader({
    cwd: invocation.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => invocation.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const customTools = invocation.customToolNames.map((name) => {
    const factory = customToolFactories[name];
    if (!factory) throw new Error(`Unknown custom tool: ${name}`);
    return factory(invocation.cwd, invocation.signal);
  });
  const toolNames = [...invocation.builtinTools, ...invocation.customToolNames];
  const { session } = await createAgentSession({
    cwd: invocation.cwd,
    agentDir,
    modelRuntime,
    ...(model ? { model } : {}),
    thinkingLevel: invocation.thinkingLevel,
    tools: toolNames,
    customTools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(invocation.cwd),
  });
  return session;
}

export const piChildAgentRunner: ChildAgentRunner = async (invocation) => {
  const session = await createPiChildAgentSession(invocation);
  const abortSession = () => { void session.abort(); };
  invocation.signal.addEventListener("abort", abortSession, { once: true });
  try {
    await session.prompt(invocation.prompt, { expandPromptTemplates: false });
    const text = lastAssistantText(session.messages);
    if (!text) throw new Error(`${invocation.role} agent returned no text output`);
    return text;
  } finally {
    invocation.signal.removeEventListener("abort", abortSession);
    session.dispose();
  }
};

function resolveModel(reference: string, runtime: ModelRuntime): ReturnType<ModelRuntime["getModel"]> {
  const separator = reference.indexOf("/");
  if (separator > 0) return runtime.getModel(reference.slice(0, separator), reference.slice(separator + 1));
  const matches = runtime.getModels().filter((candidate) => candidate.id === reference);
  return matches.length === 1 ? matches[0] : undefined;
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const value = part as { type?: string; text?: string };
          return value.type === "text" && typeof value.text === "string" ? value.text : "";
        })
        .join("");
      if (text) return text;
    }
  }
  return "";
}
