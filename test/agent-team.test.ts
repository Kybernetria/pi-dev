import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createProtocolFabric,
  ensureProtocolFabric,
  type ProtocolInvocationContext,
  type ProtocolRuntimeEvent,
} from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import manifest from "../pi.protocol.json" with { type: "json" };
import profilesJson from "../pi.agents.json" with { type: "json" };
import { createAgentExecutors } from "../protocol/agents.ts";
import { createPiChildAgentSession, wrapRealSession } from "../src/runtime/pi-runner.ts";
import { agentProfileFor, provideContractFor } from "../src/runtime/manifest.ts";
import { prepareAgentInput, type AgentRunnerInvocation, type ChildAgentRunner } from "../src/runtime/run-agent.ts";
import { architectDefinition, reviewerDefinition, scoutDefinition, securityReviewerDefinition, workerDefinition } from "../src/roles/index.ts";

const typedDefinition = parseProtocolManifest(manifest, { allowLegacyV02: false });
const typedManifest = typedDefinition.manifest;

function outputFor(role: string): string {
  if (role === "scout") return JSON.stringify({
    summary: "Located flow", files: [{ path: "src/auth.ts", line: 12, relevance: "Starts token refresh" }],
    codePaths: [{ from: "src/router.ts", to: "src/auth.ts", relationship: "Calls refresh handler" }],
    findings: ["Refresh starts in auth.ts"], unresolvedQuestions: [], diagnostics: [], message: "Scout complete.",
  });
  if (role === "architect") return JSON.stringify({
    summary: "Plan ready", assumptions: ["Existing API remains stable"], plan: [{ order: 1, action: "Implement", rationale: "Required" }],
    risks: [{ risk: "Regression", mitigation: "Run tests" }], acceptanceCriteria: ["Tests pass"], diagnostics: [], message: "Architecture complete.",
  });
  if (role === "worker") return JSON.stringify({
    summary: "Implemented", changedFiles: [{ path: "a.ts", change: "Updated" }],
    tests: [{ command: "npm test", status: "passed", output: "ok" }], unresolvedIssues: [], diagnostics: [], message: "Work complete.",
  });
  if (role === "security_reviewer") return JSON.stringify({
    summary: "Security reviewed", verdict: "approve",
    threatModel: [{ asset: "credentials", threat: "disclosure", mitigation: "redaction" }],
    findings: [{ severity: "low", area: "logging", file: "src/auth.ts", line: 12, exploitability: "low", explanation: "Metadata is logged", recommendedFix: "Redact it" }],
    testResults: [{ command: "npm test", status: "passed", output: "ok" }], diagnostics: [], message: "Security review complete.",
  });
  return JSON.stringify({
    summary: "Reviewed", verdict: "approve",
    findings: [{ severity: "info", file: "src/auth.ts", line: 12, explanation: "Flow is correct", recommendedFix: "None" }],
    testResults: [{ command: "npm test", status: "passed", output: "ok" }], diagnostics: [], message: "Review complete.",
  });
}

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-dev-"));
}

function register(runner: ChildAgentRunner) {
  const fabric = createProtocolFabric();
  fabric.install(typedDefinition, {
    agents: createAgentExecutors({ runner }),
  });
  return fabric;
}

test("manifest registers exactly the five public agent provides", () => {
  const fabric = register(async (invocation) => outputFor(invocation.role));
  const node = fabric.describeNode("pi_dev");
  assert.deepEqual(node?.provides.map((provide) => provide.name), ["scout", "architect", "worker", "reviewer", "security_reviewer"]);
  assert.deepEqual(node?.provides.map((provide) => provide.execution), [
    { type: "agent", agent: "scout" },
    { type: "agent", agent: "architect" },
    { type: "agent", agent: "worker" },
    { type: "agent", agent: "reviewer" },
    { type: "agent", agent: "security_reviewer" },
  ]);
});

test("all provide schemas completely describe their role-specific input and output", () => {
  const expected = {
    scout: {
      input: ["task", "cwd", "context", "scope", "questions"],
      output: ["summary", "files", "codePaths", "findings", "unresolvedQuestions", "diagnostics", "message"],
    },
    architect: {
      input: ["task", "cwd", "context", "constraints"],
      output: ["summary", "assumptions", "plan", "risks", "acceptanceCriteria", "diagnostics", "message"],
    },
    worker: {
      input: ["task", "cwd", "context", "plan", "acceptanceCriteria"],
      output: ["summary", "changedFiles", "tests", "unresolvedIssues", "diagnostics", "message"],
    },
    reviewer: {
      input: ["task", "cwd", "context", "diff", "commit", "range", "acceptanceCriteria", "testExpectations"],
      output: ["summary", "verdict", "findings", "testResults", "diagnostics", "message"],
    },
    security_reviewer: {
      input: ["task", "cwd", "context", "diff", "commit", "range", "acceptanceCriteria", "testExpectations", "securityFocus"],
      output: ["summary", "verdict", "threatModel", "findings", "testResults", "diagnostics", "message"],
    },
  } as const;

  for (const provide of typedManifest.provides) {
    const role = provide.name as keyof typeof expected;
    assert.deepEqual(Object.keys(provide.inputSchema.properties ?? {}), [...expected[role].input].sort(), `${role} input properties`);
    assert.deepEqual(Object.keys(provide.outputSchema.properties ?? {}), [...expected[role].output].sort(), `${role} output properties`);
    assert.deepEqual(provide.inputSchema.required, ["task"], `${role} required inputs`);
    assert.deepEqual(provide.outputSchema.required, expected[role].output, `${role} required outputs`);
  }
});

test("manifest output schemas are the sole runtime output contract", async () => {
  const invalidate = {
    scout: (value: any) => { value.files[0].line = 1.5; },
    architect: (value: any) => { value.plan[0].order = "first"; },
    worker: (value: any) => { value.tests[0].status = "unknown"; },
    reviewer: (value: any) => { value.findings[0].severity = "critical"; },
    security_reviewer: (value: any) => { value.findings[0].exploitability = "certain"; },
  } as const;

  for (const provide of typedManifest.provides) {
    const role = provide.name as keyof typeof invalidate;
    const valid = JSON.parse(outputFor(role));
    assert.equal((await invokeRawAgentOutput(role, valid)).ok, true, `${role} schema accepts representative output`);

    for (const required of provide.outputSchema.required ?? []) {
      const missing = structuredClone(valid);
      delete missing[required];
      const result = await invokeRawAgentOutput(role, missing);
      assert.equal(result.ok, false, `${role} schema requires ${required}`);
      if (!result.ok) assert.equal(result.error.code, "OUTPUT_INVALID");
    }

    const malformed = structuredClone(valid);
    invalidate[role](malformed);
    const result = await invokeRawAgentOutput(role, malformed);
    assert.equal(result.ok, false, `${role} schema rejects malformed nested output`);
    if (!result.ok) assert.equal(result.error.code, "OUTPUT_INVALID");
  }
});

async function invokeRawAgentOutput(role: string, output: unknown) {
  const fabric = createProtocolFabric();
  fabric.install(typedDefinition, {
    agents: Object.fromEntries(typedManifest.provides.map((provide) => [
      provide.name,
      async () => provide.name === role ? output : JSON.parse(outputFor(provide.name)),
    ])),
  });
  return fabric.invoke({ nodeId: "pi_dev", provide: role, input: { task: "Validate schema" } });
}

test("all agent executors return schema-compatible structured output", async () => {
  const cwd = await fixture();
  const fabric = register(async (invocation) => outputFor(invocation.role));
  for (const provide of ["scout", "architect", "worker", "reviewer", "security_reviewer"]) {
    const result = await fabric.invoke({ nodeId: "pi_dev", provide, input: { task: "Do it", cwd } });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(typeof (result.output as { message: unknown }).message, "string");
  }
});

test("agent executors emit the standard protocol runtime telemetry", async () => {
  const cwd = await fixture();
  const events: ProtocolRuntimeEvent[] = [];
  const fabric = register(async (invocation) => outputFor(invocation.role));
  fabric.subscribeRuntimeEventRecorder((event) => { events.push(event); });
  const result = await fabric.invoke({
    nodeId: "pi_dev",
    provide: "architect",
    input: { task: "Plan", cwd },
    traceId: "pi-dev-runtime-trace",
    spanId: "pi-dev-runtime-span",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events.map((event) => event.type), [
    "executor_session_model",
    "executor_input_snapshot",
    "executor_output_delta",
    "executor_output_snapshot",
  ]);
  const modelEvent = events[0];
  assert.equal(modelEvent?.type, "executor_session_model");
  if (modelEvent?.type === "executor_session_model") {
    assert.equal(modelEvent.model, agentProfileFor("architect").modelPolicy?.specific);
    assert.equal(modelEvent.thinkingLevel, agentProfileFor("architect").modelPolicy?.thinkingLevel);
  }
});

test("fabric and runtime reject invalid inputs", async () => {
  const cwd = await fixture();
  const fabric = register(async (invocation) => outputFor(invocation.role));
  const absent = await fabric.invoke({ nodeId: "pi_dev", provide: "architect", input: { cwd } });
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error.code, "INPUT_INVALID");
  const empty = await fabric.invoke({ nodeId: "pi_dev", provide: "architect", input: { task: "", cwd } });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.code, "EXECUTION_FAILED");
});

test("role tool restrictions are enforced in runner configuration", async () => {
  const cwd = await fixture();
  const seen: AgentRunnerInvocation[] = [];
  const fabric = register(async (invocation) => { seen.push(invocation); return outputFor(invocation.role); });
  for (const provide of ["scout", "architect", "worker", "reviewer", "security_reviewer"]) {
    await fabric.invoke({ nodeId: "pi_dev", provide, input: { task: "Inspect", cwd } });
  }
  const byRole = Object.fromEntries(seen.map((invocation) => [invocation.role, invocation]));
  assert.deepEqual(byRole.scout?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.equal(byRole.scout?.builtinTools.includes("bash"), false);
  assert.deepEqual(byRole.architect?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(byRole.architect?.customToolNames, ["protocol"]);
  assert.deepEqual(byRole.worker?.builtinTools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual(byRole.worker?.customToolNames, ["protocol"]);
  assert.deepEqual(byRole.reviewer?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(byRole.reviewer?.customToolNames, ["review_command", "protocol"]);
  assert.deepEqual(byRole.security_reviewer?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(byRole.security_reviewer?.customToolNames, ["review_command", "protocol"]);
  assert.equal(byRole.scout?.model, "openai-codex/gpt-5.6-luna");
  assert.equal(byRole.scout?.thinkingLevel, "medium");
  assert.equal(byRole.architect?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(byRole.architect?.thinkingLevel, "high");
  assert.equal(byRole.worker?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(byRole.worker?.thinkingLevel, "medium");
  assert.equal(byRole.reviewer?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(byRole.reviewer?.thinkingLevel, "high");
  assert.equal(byRole.security_reviewer?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(byRole.security_reviewer?.thinkingLevel, "high");
});

test("real SDK applies the scout manifest tool allowlist", async () => {
  const cwd = await fixture();
  const prepared = await prepareAgentInput(
    scoutDefinition,
    { task: "Inspect the fixture.", cwd },
    agentProfileFor("scout"),
    provideContractFor("scout"),
    {},
  );
  const session = await createPiChildAgentSession(prepared, scoutDefinition, agentProfileFor("scout"));
  try {
    const introspection = session as typeof session & { getActiveToolNames(): string[] };
    assert.deepEqual(introspection.getActiveToolNames(), agentProfileFor("scout").tools);
    assert.ok(session.thinkingLevel === "medium" || session.thinkingLevel === "off");
  } finally {
    session.dispose();
  }
});

test("real session adapter forwards only the final assistant response and exposes model failures", async () => {
  const finalOutput = outputFor("scout");
  const successfulSession = fakeAgentSession([
    {
      role: "assistant",
      content: [{ type: "text", text: "I will inspect {\"path\":\"package.json\"}." }],
      stopReason: "toolUse",
    },
    {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      stopReason: "stop",
    },
  ]);
  const wrapped = wrapRealSession(successfulSession, new AbortController(), () => undefined, "scout");
  let forwarded = "";
  wrapped.subscribe((event) => {
    if (event.type === "message_update" && "assistantMessageEvent" in event && event.assistantMessageEvent.type === "text_delta") {
      forwarded += event.assistantMessageEvent.delta;
    }
  });
  await wrapped.prompt("Inspect");
  assert.equal(forwarded, finalOutput);
  wrapped.dispose();

  const failedSession = fakeAgentSession([{
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "upstream rate limit",
  }]);
  const failed = wrapRealSession(failedSession, new AbortController(), () => undefined, "scout");
  await assert.rejects(() => failed.prompt("Inspect"), /scout agent failed.*upstream rate limit/);
  failed.dispose();
});

function fakeAgentSession(assistantMessages: unknown[]): AgentSession {
  const listeners = new Set<(event: any) => void>();
  return {
    model: { provider: "test", id: "fake" },
    thinkingLevel: "off",
    messages: [],
    agent: { state: { tools: [] } },
    async prompt() {
      for (const message of assistantMessages) {
        for (const listener of listeners) listener({ type: "message_end", message });
      }
    },
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async abort() {},
    dispose() { listeners.clear(); },
    getActiveToolNames() { return []; },
  } as unknown as AgentSession;
}

test("real SDK injects protocol only into delegating roles and binds nested provenance", async () => {
  const cwd = await fixture();
  const fabric = ensureProtocolFabric();
  const fixtureDefinition = parseProtocolManifest({
    $schema: "https://pi.dev/protocol/manifest-v1.schema.json",
    schemaVersion: 1,
    node: { id: "pi_dev", purpose: "Nested provenance fixture" },
    provides: [{
      name: "scout",
      description: "Fixture scout",
      inputSchema: {
        type: "object", required: ["task"],
        properties: { task: { type: "string" } }, additionalProperties: false,
      },
      outputSchema: {
        type: "object", required: ["found"],
        properties: { found: { type: "boolean" } }, additionalProperties: false,
      },
      effects: ["fs.read"],
    }],
  }, { allowLegacyV02: false });
  const registration = fabric.install(fixtureDefinition, { handlers: { scout: () => ({ found: true }) } });
  const prepared = await prepareAgentInput(
    architectDefinition,
    { task: "Inspect the fixture.", cwd },
    agentProfileFor("architect"),
    provideContractFor("architect"),
    {},
  );
  const session = await createPiChildAgentSession(prepared, architectDefinition, agentProfileFor("architect"));
  session.setProtocolInvocationContext?.({
    nodeId: "pi_dev",
    provide: "architect",
    traceId: "architect_trace",
    spanId: "architect_span",
    childCounter: 0,
  });
  const events: Array<{ traceId: string; parentSpanId?: string; callerNodeId?: string; nodeId: string; provide: string; status: string }> = [];
  const unsubscribe = fabric.subscribeProvenanceRecorder((event) => { events.push(event); });
  try {
    const introspection = session as typeof session & {
      getActiveToolNames(): string[];
      getActiveTool(name: string): { execute: (...args: any[]) => Promise<unknown> } | undefined;
    };
    assert.deepEqual(introspection.getActiveToolNames(), agentProfileFor("architect").tools);
    const protocolTool = introspection.getActiveTool("protocol");
    assert.ok(protocolTool);
    await protocolTool.execute("nested-provenance-test", { target: "pi_dev.scout", input: { task: "inspect" } });
    const nested = events.find((event) => event.nodeId === "pi_dev" && event.provide === "scout" && event.status === "started");
    assert.ok(nested);
    assert.equal(nested.traceId, "architect_trace");
    assert.equal(nested.parentSpanId, "architect_span");
    assert.equal(nested.callerNodeId, "pi_dev.architect");
  } finally {
    unsubscribe();
    session.dispose();
    await registration.dispose();
  }
});

test("scout is configured for fast, concise, read-only exploration", async () => {
  const cwd = await fixture();
  let seen: AgentRunnerInvocation | undefined;
  const fabric = register(async (invocation) => { seen = invocation; return outputFor(invocation.role); });
  const result = await fabric.invoke({
    nodeId: "pi_dev",
    provide: "scout",
    input: { task: "Trace refresh", cwd, scope: ["src/auth"], questions: ["Who calls refresh?"] },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(seen?.model, "openai-codex/gpt-5.6-luna");
  assert.equal(seen?.thinkingLevel, "medium");
  assert.deepEqual(seen?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(seen?.customToolNames, []);
  assert.match(seen?.systemPrompt ?? "", /fast software scout/i);
  assert.match(seen?.systemPrompt ?? "", /strictly read-only/i);
  assert.match(seen?.systemPrompt ?? "", /keep findings concise/i);
  assert.match(seen?.prompt ?? "", /src\/auth/);
  assert.match(seen?.prompt ?? "", /Who calls refresh\?/);
  assert.equal("agents" in manifest, false, "public contract must not expose deployment profiles");
  assert.deepEqual(profilesJson.agents.scout.tools, ["read", "grep", "find", "ls"]);
  assert.equal("protocolAccess" in profilesJson.agents.scout, false);
  for (const role of ["architect", "worker", "reviewer", "security_reviewer"] as const) {
    assert.deepEqual(profilesJson.agents[role].protocolAccess.targets, ["pi_dev.scout"]);
    assert.equal(profilesJson.agents[role].tools.includes("protocol"), true);
  }
  assert.equal(profilesJson.agents.scout.modelPolicy.class, "fast");
  assert.equal(profilesJson.agents.scout.modelPolicy.thinkingLevel, "medium");
});

test("cwd is canonicalized and non-directories are rejected", async () => {
  const cwd = await fixture();
  let actual = "";
  const fabric = register(async (invocation) => { actual = invocation.cwd; return outputFor(invocation.role); });
  const ok = await fabric.invoke({ nodeId: "pi_dev", provide: "architect", input: { task: "Plan", cwd: join(cwd, ".") } });
  assert.equal(ok.ok, true);
  assert.equal(actual, cwd);
  const file = join(cwd, "file.txt");
  await writeFile(file, "x");
  const bad = await fabric.invoke({ nodeId: "pi_dev", provide: "architect", input: { task: "Plan", cwd: file } });
  assert.equal(bad.ok, false);
});

test("agents have no internal wall-clock timeout and caller cancellation reaches the child runner", async () => {
  const cwd = await fixture();
  let callerAborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const cancelled: ChildAgentRunner = (invocation) => new Promise((_resolve, reject) => {
    markStarted();
    invocation.signal.addEventListener("abort", () => { callerAborted = true; reject(invocation.signal.reason); }, { once: true });
  });
  const controller = new AbortController();
  const pending = register(cancelled).invoke({
    nodeId: "pi_dev",
    provide: "reviewer",
    input: { task: "Wait", cwd },
    abortSignal: controller.signal,
  });
  await started;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  assert.equal(callerAborted, false, "legacy timeoutMs input must not create an internal deadline");
  controller.abort();
  const cancelResult = await pending;
  assert.equal(cancelResult.ok, false);
  if (!cancelResult.ok) assert.equal(cancelResult.error.code, "CANCELLED");
  assert.equal(callerAborted, true);
});

test("malformed, failed, and oversized agent output fail clearly", async () => {
  const cwd = await fixture();
  for (const runner of [
    async () => "not json",
    async () => { throw new Error("model unavailable"); },
    async () => "x".repeat(100),
  ] satisfies ChildAgentRunner[]) {
    const agentExecutors = createAgentExecutors({ runner, maxResponseChars: 20 });
    await assert.rejects(() => Promise.resolve(agentExecutors.architect?.({ task: "Plan", cwd }, {
      nodeId: "pi_dev",
      provide: "architect",
    } as ProtocolInvocationContext)));
  }
});

test("model-visible prompt truncation is diagnosed in structured output", async () => {
  const cwd = await fixture();
  let prompt = "";
  const agentExecutors = createAgentExecutors({
    maxPromptChars: 80,
    runner: async (invocation) => { prompt = invocation.prompt; return outputFor(invocation.role); },
  });
  const output = await agentExecutors.architect?.({ task: "x".repeat(500), cwd }, {
    nodeId: "pi_dev",
    provide: "architect",
  }) as { diagnostics: string[]; message: string };
  assert.match(prompt, /DIAGNOSTIC: input was truncated/);
  assert.match(output.diagnostics[0] ?? "", /truncated/);
  assert.match(output.message, /truncated/);
});
