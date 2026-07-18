import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createProtocolFabric,
  registerProtocolManifest,
  type PiProtocolManifest,
  type ProtocolInvocationContext,
} from "@kybernetria/pi-protocol";
import manifest from "../pi.protocol.json" with { type: "json" };
import { createAgentExecutors } from "../protocol/agents.ts";
import { createPiChildAgentSession } from "../src/runtime/pi-runner.ts";
import type { AgentDefinition } from "../src/runtime/definition.ts";
import type { AgentRunnerInvocation, ChildAgentRunner } from "../src/runtime/run-agent.ts";
import { architectDefinition, reviewerDefinition, scoutDefinition, securityReviewerDefinition, workerDefinition } from "../src/roles/index.ts";

const typedManifest = manifest as unknown as PiProtocolManifest;

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
  registerProtocolManifest(fabric, {
    manifest: typedManifest,
    manifestBaseDir: fileURLToPath(new URL("..", import.meta.url)),
    agentExecutors: createAgentExecutors({ runner }),
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
      input: ["task", "cwd", "context", "model", "thinkingLevel", "timeoutMs", "scope", "questions"],
      output: ["summary", "files", "codePaths", "findings", "unresolvedQuestions", "diagnostics", "message"],
    },
    architect: {
      input: ["task", "cwd", "context", "model", "thinkingLevel", "timeoutMs", "constraints", "outputDepth"],
      output: ["summary", "assumptions", "plan", "risks", "acceptanceCriteria", "diagnostics", "message"],
    },
    worker: {
      input: ["task", "cwd", "context", "model", "thinkingLevel", "timeoutMs", "plan", "acceptanceCriteria"],
      output: ["summary", "changedFiles", "tests", "unresolvedIssues", "diagnostics", "message"],
    },
    reviewer: {
      input: ["task", "cwd", "context", "model", "thinkingLevel", "timeoutMs", "diff", "commit", "range", "acceptanceCriteria", "testExpectations"],
      output: ["summary", "verdict", "findings", "testResults", "diagnostics", "message"],
    },
    security_reviewer: {
      input: ["task", "cwd", "context", "model", "thinkingLevel", "timeoutMs", "diff", "commit", "range", "acceptanceCriteria", "testExpectations", "securityFocus"],
      output: ["summary", "verdict", "threatModel", "findings", "testResults", "diagnostics", "message"],
    },
  } as const;

  for (const provide of typedManifest.provides) {
    const role = provide.name as keyof typeof expected;
    assert.deepEqual(Object.keys(provide.inputSchema.properties ?? {}), expected[role].input, `${role} input properties`);
    assert.deepEqual(Object.keys(provide.outputSchema.properties ?? {}), expected[role].output, `${role} output properties`);
    assert.deepEqual(provide.inputSchema.required, ["task"], `${role} required inputs`);
    assert.deepEqual(provide.outputSchema.required, expected[role].output, `${role} required outputs`);
  }
});

test("runtime output validation and manifest schemas agree for every role", async () => {
  const definitions: Record<string, AgentDefinition<any, any>> = {
    scout: scoutDefinition,
    architect: architectDefinition,
    worker: workerDefinition,
    reviewer: reviewerDefinition,
    security_reviewer: securityReviewerDefinition,
  };
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
    assert.equal(definitions[role].validateOutput(valid), true, `${role} runtime accepts representative output`);
    assert.equal((await invokeRawAgentOutput(role, valid)).ok, true, `${role} schema accepts representative output`);

    for (const required of provide.outputSchema.required ?? []) {
      const missing = structuredClone(valid);
      delete missing[required];
      assert.equal(definitions[role].validateOutput(missing), false, `${role} runtime requires ${required}`);
      const result = await invokeRawAgentOutput(role, missing);
      assert.equal(result.ok, false, `${role} schema requires ${required}`);
      if (!result.ok) assert.equal(result.error.code, "INVALID_OUTPUT");
    }

    const malformed = structuredClone(valid);
    invalidate[role](malformed);
    assert.equal(definitions[role].validateOutput(malformed), false, `${role} runtime rejects malformed nested output`);
    const result = await invokeRawAgentOutput(role, malformed);
    assert.equal(result.ok, false, `${role} schema rejects malformed nested output`);
    if (!result.ok) assert.equal(result.error.code, "INVALID_OUTPUT");
  }
});

async function invokeRawAgentOutput(role: string, output: unknown) {
  const fabric = createProtocolFabric();
  registerProtocolManifest(fabric, {
    manifest: typedManifest,
    manifestBaseDir: fileURLToPath(new URL("..", import.meta.url)),
    agentExecutors: Object.fromEntries(typedManifest.provides.map((provide) => [
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

test("fabric and runtime reject invalid inputs", async () => {
  const cwd = await fixture();
  const fabric = register(async (invocation) => outputFor(invocation.role));
  const absent = await fabric.invoke({ nodeId: "pi_dev", provide: "architect", input: { cwd } });
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error.code, "INVALID_INPUT");
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
  assert.deepEqual(byRole.worker?.builtinTools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual(byRole.reviewer?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(byRole.reviewer?.customToolNames, ["review_command"]);
  assert.deepEqual(byRole.security_reviewer?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(byRole.security_reviewer?.customToolNames, ["review_command"]);
});

test("real SDK initializes a scout session with the supported model runtime", async () => {
  const cwd = await fixture();
  const session = await createPiChildAgentSession({
    role: "scout",
    cwd,
    prompt: "Inspect the fixture.",
    systemPrompt: "You are a read-only scout.",
    builtinTools: ["read", "grep", "find", "ls"],
    customToolNames: [],
    thinkingLevel: "minimal",
    signal: new AbortController().signal,
  });
  try {
    assert.deepEqual(session.agent.state.tools.map((tool) => tool.name), ["read", "grep", "find", "ls"]);
    assert.ok(session.thinkingLevel === "minimal" || session.thinkingLevel === "off");
  } finally {
    session.dispose();
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
  assert.equal(seen?.thinkingLevel, "minimal");
  assert.deepEqual(seen?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(seen?.customToolNames, []);
  assert.match(seen?.systemPrompt ?? "", /fast software scout/i);
  assert.match(seen?.systemPrompt ?? "", /strictly read-only/i);
  assert.match(seen?.systemPrompt ?? "", /keep findings concise/i);
  assert.match(seen?.prompt ?? "", /src\/auth/);
  assert.match(seen?.prompt ?? "", /Who calls refresh\?/);
  assert.deepEqual(manifest.agents.scout.tools, ["read", "grep", "find", "ls"]);
  assert.equal(manifest.agents.scout.modelHint.tier, "fast");
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

test("timeout and caller cancellation reach the child runner", async () => {
  const cwd = await fixture();
  let timeoutAborted = false;
  const never: ChildAgentRunner = (invocation) => new Promise((_resolve, reject) => {
    invocation.signal.addEventListener("abort", () => { timeoutAborted = true; reject(invocation.signal.reason); }, { once: true });
  });
  const timeoutResult = await register(never).invoke({ nodeId: "pi_dev", provide: "worker", input: { task: "Wait", cwd, timeoutMs: 10 } });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutAborted, true);

  let callerAborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const cancelled: ChildAgentRunner = (invocation) => new Promise((_resolve, reject) => {
    markStarted();
    invocation.signal.addEventListener("abort", () => { callerAborted = true; reject(invocation.signal.reason); }, { once: true });
  });
  const controller = new AbortController();
  const pending = register(cancelled).invoke({ nodeId: "pi_dev", provide: "reviewer", input: { task: "Wait", cwd }, abortSignal: controller.signal });
  await started;
  controller.abort();
  const cancelResult = await pending;
  assert.equal(cancelResult.ok, false);
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
