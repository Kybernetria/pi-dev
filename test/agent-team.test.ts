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
import type { AgentRunnerInvocation, ChildAgentRunner } from "../src/runtime/run-agent.ts";

const typedManifest = manifest as unknown as PiProtocolManifest;

function outputFor(role: string): string {
  if (role === "architect") return JSON.stringify({
    summary: "Plan ready", assumptions: [], plan: [{ order: 1, action: "Implement", rationale: "Required" }],
    risks: [], acceptanceCriteria: ["Tests pass"], diagnostics: [], message: "Architecture complete.",
  });
  if (role === "worker") return JSON.stringify({
    summary: "Implemented", changedFiles: [{ path: "a.ts", change: "Updated" }],
    tests: [{ command: "npm test", status: "passed", output: "ok" }], unresolvedIssues: [], diagnostics: [], message: "Work complete.",
  });
  if (role === "security_reviewer") return JSON.stringify({
    summary: "Security reviewed", verdict: "approve", threatModel: [], findings: [],
    testResults: [{ command: "npm test", status: "passed", output: "ok" }], diagnostics: [], message: "Security review complete.",
  });
  return JSON.stringify({
    summary: "Reviewed", verdict: "approve", findings: [],
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

test("manifest registers exactly the four public agent provides", () => {
  const fabric = register(async (invocation) => outputFor(invocation.role));
  const node = fabric.describeNode("pi_dev");
  assert.deepEqual(node?.provides.map((provide) => provide.name), ["architect", "worker", "reviewer", "security_reviewer"]);
  assert.deepEqual(node?.provides.map((provide) => provide.execution), [
    { type: "agent", agent: "architect" },
    { type: "agent", agent: "worker" },
    { type: "agent", agent: "reviewer" },
    { type: "agent", agent: "security_reviewer" },
  ]);
});

test("all agent executors return schema-compatible structured output", async () => {
  const cwd = await fixture();
  const fabric = register(async (invocation) => outputFor(invocation.role));
  for (const provide of ["architect", "worker", "reviewer", "security_reviewer"]) {
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
  for (const provide of ["architect", "worker", "reviewer", "security_reviewer"]) {
    await fabric.invoke({ nodeId: "pi_dev", provide, input: { task: "Inspect", cwd } });
  }
  assert.deepEqual(seen[0]?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.equal(seen[0]?.builtinTools.includes("bash"), false);
  assert.deepEqual(seen[1]?.builtinTools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual(seen[2]?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(seen[2]?.customToolNames, ["review_command"]);
  assert.deepEqual(seen[3]?.builtinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(seen[3]?.customToolNames, ["review_command"]);
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
