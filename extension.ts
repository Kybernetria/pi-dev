import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ensureProtocolFabric,
  registerProtocolManifest,
  type PiProtocolManifest,
} from "@kybernetria/pi-protocol";
import { createAgentExecutors } from "./protocol/agents.ts";

const manifest = JSON.parse(
  readFileSync(new URL("./pi.protocol.json", import.meta.url), "utf8"),
) as PiProtocolManifest;
const MANIFEST_BASE_DIR = fileURLToPath(new URL(".", import.meta.url));

export default function piDevExtension(_pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  fabric.unregister(manifest.nodeId);
  registerProtocolManifest(fabric, {
    manifest,
    manifestBaseDir: MANIFEST_BASE_DIR,
    agentExecutors: createAgentExecutors(),
  });
}
