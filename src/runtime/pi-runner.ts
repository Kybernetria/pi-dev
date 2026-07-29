import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ensureProtocolFabric,
  runWithProtocolInvocationContextValue,
  type CurrentProtocolInvocationContext,
} from "@kybernetria/pi-protocol/core";
import { createProtocolTool } from "@kybernetria/pi-protocol/pi";
import type { ResolvedPiAgentProfile } from "@kybernetria/pi-protocol/sdk/agent-profile";
import {
  UNIVERSAL_PROTOCOL_AWARENESS_PROMPT,
} from "@kybernetria/pi-protocol/sdk/agent-session";
import {
  runWithPiSdkProtocolControlContext,
  type PiSdkAgentSessionEventLike,
  type PiSdkAgentSessionLike,
  type PiSdkProtocolControlContext,
} from "@kybernetria/pi-protocol/sdk";
import type { AgentDefinition } from "./definition.ts";
import type { ChildAgentRunner, PreparedAgentInput } from "./run-agent.ts";
import { createReviewCommandTool } from "./review-command.ts";

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const CUSTOM_TOOLS = new Set(["review_command", "protocol"]);

export async function createPiChildAgentSession(
  prepared: PreparedAgentInput,
  definition: AgentDefinition<any, any>,
  agent: ResolvedPiAgentProfile,
  runner?: ChildAgentRunner,
): Promise<PiSdkAgentSessionLike> {
  if (runner) return createRunnerBackedSession(prepared, definition, agent, runner);

  const tools = exactManifestTools(definition.role, agent);
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  const model = prepared.model ? resolveModel(prepared.model, modelRuntime) : undefined;
  if (prepared.model && !model) throw new Error(`Model not found or ambiguous: ${prepared.model}`);

  const hasProtocol = tools.includes("protocol");
  const prompt = resolvedSystemPrompt(definition.role, agent);
  const resourceLoader = new DefaultResourceLoader({
    cwd: prepared.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => prompt,
    appendSystemPromptOverride: (base: string[]) => appendUnique(base, [
      ...(hasProtocol ? [UNIVERSAL_PROTOCOL_AWARENESS_PROMPT] : []),
    ]),
  });
  await resourceLoader.reload();

  let activeProtocolContext: CurrentProtocolInvocationContext | undefined;
  let activeProtocolControl: PiSdkProtocolControlContext | undefined;
  const lifetimeController = new AbortController();
  const customTools: ToolDefinition[] = [];
  if (tools.includes("review_command")) {
    customTools.push(createReviewCommandTool(prepared.cwd, lifetimeController.signal));
  }
  if (hasProtocol) {
    customTools.push(createPolicyAwareProtocolTool(
      () => activeProtocolContext,
      () => activeProtocolControl,
    ));
  }

  const { session } = await createAgentSession({
    cwd: prepared.cwd,
    agentDir,
    modelRuntime,
    ...(model ? { model } : {}),
    thinkingLevel: prepared.thinkingLevel,
    tools,
    customTools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(prepared.cwd),
  });
  assertExactTools(definition.role, session, tools);

  return wrapRealSession(session, lifetimeController, (context) => {
    activeProtocolContext = context;
    if (context?.abortSignal) {
      if (context.abortSignal.aborted) lifetimeController.abort(context.abortSignal.reason);
      else context.abortSignal.addEventListener("abort", () => lifetimeController.abort(context.abortSignal?.reason), { once: true });
    }
  }, definition.role, (control) => { activeProtocolControl = control; });
}

function createPolicyAwareProtocolTool(
  currentContext: () => CurrentProtocolInvocationContext | undefined,
  currentControl: () => PiSdkProtocolControlContext | undefined,
): ToolDefinition {
  const tool = createProtocolTool(ensureProtocolFabric());
  return {
    ...tool,
    async execute(
      toolCallId: string,
      input: Parameters<typeof tool.execute>[1],
      signal?: AbortSignal,
      onUpdate?: Parameters<typeof tool.execute>[3],
    ) {
      const execute = () => tool.execute(toolCallId, input, signal, onUpdate);
      const context = currentContext();
      const withContext = () => context
        ? runWithProtocolInvocationContextValue(context, execute)
        : execute();
      return runWithPiSdkProtocolControlContext(currentControl(), withContext);
    },
  } as ToolDefinition;
}

function createRunnerBackedSession(
  prepared: PreparedAgentInput,
  definition: AgentDefinition<any, any>,
  agent: ResolvedPiAgentProfile,
  runner: ChildAgentRunner,
): PiSdkAgentSessionLike {
  const listeners = new Set<(event: PiSdkAgentSessionEventLike) => void>();
  const controller = new AbortController();
  const tools = exactManifestTools(definition.role, agent);
  const model = modelIdentity(prepared.model);
  return {
    ...(model ? { model } : {}),
    thinkingLevel: prepared.thinkingLevel,
    async prompt(prompt: string) {
      const raw = await runner({
        role: definition.role,
        cwd: prepared.cwd,
        prompt,
        systemPrompt: resolvedSystemPrompt(definition.role, agent),
        builtinTools: tools.filter((name) => BUILTIN_TOOLS.has(name)),
        customToolNames: tools.filter((name) => CUSTOM_TOOLS.has(name)),
        ...(prepared.model ? { model: prepared.model } : {}),
        thinkingLevel: prepared.thinkingLevel,
        signal: controller.signal,
      });
      for (const listener of listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: raw } });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      controller.abort();
      listeners.clear();
    },
    setProtocolInvocationContext(context) {
      if (context?.abortSignal) {
        if (context.abortSignal.aborted) controller.abort(context.abortSignal.reason);
        else context.abortSignal.addEventListener("abort", () => controller.abort(context.abortSignal?.reason), { once: true });
      }
    },
  };
}

export function wrapRealSession(
  session: AgentSession,
  lifetimeController: AbortController,
  setContext: (context: CurrentProtocolInvocationContext | undefined) => void,
  role = "agent",
  setControlContext: (context: PiSdkProtocolControlContext | undefined) => void = () => undefined,
): PiSdkAgentSessionLike {
  const outputListeners = new Set<(event: PiSdkAgentSessionEventLike) => void>();
  return {
    get model() { return session.model; },
    get thinkingLevel() { return session.thinkingLevel; },
    async prompt(text) {
      let finalAssistantMessage: unknown;
      const unsubscribeFinalMessage = session.subscribe((event) => {
        if (event.type === "message_end" && isAssistantMessage(event.message)) {
          finalAssistantMessage = event.message;
        }
      });
      try {
        await session.prompt(text, { expandPromptTemplates: false });
      } finally {
        unsubscribeFinalMessage();
      }

      const final = assistantResult(finalAssistantMessage);
      if (!final) throw new Error(`${role} agent returned no final assistant message`);
      if (final.errorMessage || final.stopReason === "error" || final.stopReason === "aborted") {
        const reason = final.errorMessage ?? `stop reason ${final.stopReason}`;
        throw new Error(`${role} agent failed before producing structured output: ${reason}`);
      }
      if (!final.text.trim()) {
        const suffix = final.stopReason ? ` (stop reason: ${final.stopReason})` : "";
        throw new Error(`${role} agent returned no final text output${suffix}`);
      }

      const event: PiSdkAgentSessionEventLike = {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: final.text },
      };
      for (const listener of outputListeners) listener(event);
    },
    subscribe(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    dispose() {
      outputListeners.clear();
      lifetimeController.abort();
      void session.abort();
      session.dispose();
    },
    setProtocolInvocationContext: setContext,
    setProtocolControlContext: setControlContext,
    // Introspection is intentionally outside the protocol session interface and
    // exists for conformance tests of the manifest-owned allowlist.
    getActiveToolNames: () => session.getActiveToolNames(),
    getActiveTool: (name: string) => session.agent.state.tools.find((tool) => tool.name === name),
  } as PiSdkAgentSessionLike;
}

function isAssistantMessage(value: unknown): value is {
  role: "assistant";
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
} {
  return typeof value === "object" && value !== null && (value as { role?: unknown }).role === "assistant";
}

function assistantResult(message: unknown): { text: string; stopReason?: string; errorMessage?: string } | undefined {
  if (!isAssistantMessage(message)) return undefined;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => {
          const value = part as { type?: unknown; text?: unknown };
          return value.type === "text" && typeof value.text === "string" ? value.text : "";
        }).join("")
      : "";
  return {
    text,
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? { errorMessage: message.errorMessage.trim() }
      : {}),
  };
}

function exactManifestTools(role: string, agent: ResolvedPiAgentProfile): string[] {
  if (!agent.tools) throw new Error(`Private agent ${role} must declare an exact tools allowlist`);
  const tools = [...agent.tools];
  for (const name of tools) {
    if (!BUILTIN_TOOLS.has(name) && !CUSTOM_TOOLS.has(name)) throw new Error(`Private agent ${role} declares unsupported tool ${name}`);
  }
  return tools;
}

function resolvedSystemPrompt(role: string, agent: ResolvedPiAgentProfile): string {
  if (!agent.promptText) throw new Error(`Private agent ${role} must have a resolved system prompt`);
  return agent.promptText;
}

function assertExactTools(role: string, session: AgentSession, expected: string[]): void {
  const actual = session.getActiveToolNames().slice().sort();
  const sortedExpected = expected.slice().sort();
  if (actual.length !== sortedExpected.length || actual.some((name, index) => name !== sortedExpected[index])) {
    throw new Error(`Private tools for ${role} were not applied: expected ${JSON.stringify(sortedExpected)}, active ${JSON.stringify(actual)}`);
  }
}

function resolveModel(reference: string, runtime: ModelRuntime): ReturnType<ModelRuntime["getModel"]> {
  const separator = reference.indexOf("/");
  if (separator > 0) return runtime.getModel(reference.slice(0, separator), reference.slice(separator + 1));
  const matches = runtime.getModels().filter((candidate) => candidate.id === reference);
  return matches.length === 1 ? matches[0] : undefined;
}

function modelIdentity(reference: string | undefined): { provider?: string; id: string } | undefined {
  if (!reference) return undefined;
  const separator = reference.indexOf("/");
  return separator > 0
    ? { provider: reference.slice(0, separator), id: reference.slice(separator + 1) }
    : { id: reference };
}

function appendUnique(base: string[], chunks: string[]): string[] {
  const result = [...base];
  for (const chunk of chunks) if (!result.some((item) => item.includes(chunk))) result.push(chunk);
  return result;
}
