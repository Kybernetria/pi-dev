import { spawn } from "node:child_process";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const MAX_TOOL_OUTPUT = 32_000;
const SAFE_TARGET = /^[A-Za-z0-9_./~^@{}:+-]+$/;

export function createReviewCommandTool(cwd: string, signal: AbortSignal): ToolDefinition {
  return defineTool({
    name: "review_command",
    label: "Review command",
    description: "Run source-read-only git inspection or a standard project test runner. No shell is used.",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("git_status"),
        Type.Literal("git_diff"),
        Type.Literal("git_show"),
        Type.Literal("test"),
      ]),
      target: Type.Optional(Type.String({ description: "A git revision/range/path target; options are rejected." })),
      testRunner: Type.Optional(Type.Union([Type.Literal("npm"), Type.Literal("pnpm"), Type.Literal("yarn"), Type.Literal("bun")])),
      testArgs: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_toolCallId, input) => {
      const command = buildCommand(input);
      const result = await spawnCaptured(command.executable, command.args, cwd, signal);
      const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      const { text, truncated } = truncate(combined, MAX_TOOL_OUTPUT);
      return {
        content: [{
          type: "text",
          text: `${command.executable} ${command.args.join(" ")} exited ${result.code}\n${text}${truncated ? `\n[diagnostic: review command output truncated to ${MAX_TOOL_OUTPUT} characters]` : ""}`,
        }],
        details: { exitCode: result.code, truncated },
      };
    },
  });
}

function buildCommand(input: {
  operation: "git_status" | "git_diff" | "git_show" | "test";
  target?: string;
  testRunner?: "npm" | "pnpm" | "yarn" | "bun";
  testArgs?: string[];
}): { executable: string; args: string[] } {
  if (input.operation === "git_status") return { executable: "git", args: ["--no-pager", "status", "--short"] };
  if (input.operation === "git_diff" || input.operation === "git_show") {
    const target = input.target?.trim();
    if (target && (target.startsWith("-") || !SAFE_TARGET.test(target))) throw new Error("Unsafe git target");
    return {
      executable: "git",
      args: ["--no-pager", input.operation === "git_diff" ? "diff" : "show", "--no-ext-diff", "--no-textconv", ...(target ? [target] : [])],
    };
  }
  const runner = input.testRunner;
  if (!runner) throw new Error("testRunner is required for test operation");
  const supplied = input.testArgs ?? [];
  if (supplied.some((arg) => arg.includes("\0") || arg.includes("\n") || arg.includes("\r"))) throw new Error("Unsafe test argument");
  const prefix = runner === "npm" ? ["test", "--"] : ["test"];
  return { executable: runner, args: [...prefix, ...supplied] };
}

function spawnCaptured(executable: string, args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, signal, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}
