import { readFileSync } from "node:fs";

export function loadAgentPrompt(name: "scout" | "architect" | "worker" | "reviewer" | "security-reviewer"): string {
  return readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), "utf8").trim();
}
