import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureProtocolFabric, registerProtocolManifest } from "@kybernetria/pi-protocol";
import { createAgentExecutors } from "./protocol/agents.ts";
import { MANIFEST_BASE_DIR, protocolManifest, protocolNamespace } from "./src/runtime/manifest.ts";

export default function piDevExtension(_pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  fabric.unregister(protocolNamespace.nodeId);
  registerProtocolManifest(fabric, {
    manifest: protocolManifest,
    manifestBaseDir: MANIFEST_BASE_DIR,
    agentExecutors: createAgentExecutors(),
  });
}
