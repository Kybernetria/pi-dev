import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createProtocolNamespace,
  parseProtocolManifest,
  resolveManifestSystemPrompts,
  type ProtocolAgentSpec,
  type ProvideSpec,
} from "@kybernetria/pi-protocol";
import type { AgentRole } from "./definition.ts";

export const MANIFEST_BASE_DIR = fileURLToPath(new URL("../..", import.meta.url));

const rawManifest = parseProtocolManifest(
  readFileSync(fileURLToPath(new URL("../../pi.protocol.json", import.meta.url)), "utf8"),
);

/** The resolved protocol manifest is the sole runtime configuration source. */
export const protocolManifest = resolveManifestSystemPrompts(rawManifest, {
  manifestBaseDir: MANIFEST_BASE_DIR,
});
export const protocolNamespace = createProtocolNamespace(protocolManifest);

export function agentSpecFor(role: AgentRole): ProtocolAgentSpec {
  const agent = protocolManifest.agents?.[role];
  if (!agent) throw new Error(`Manifest is missing agent ${role}`);
  return agent;
}

export function provideSpecFor(role: AgentRole): ProvideSpec {
  const target = protocolNamespace.agent(role);
  const provide = protocolManifest.provides.find((candidate) => candidate.name === target.provide);
  if (!provide) throw new Error(`Manifest namespace lost agent provide ${role}`);
  return provide;
}
