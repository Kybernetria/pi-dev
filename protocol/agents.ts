import { AsyncLocalStorage } from "node:async_hooks";
import type { ProtocolAgentExecutor, ProtocolAgentSpec } from "@kybernetria/pi-protocol";
import { createPiSdkAgentExecutorsFromManifest } from "@kybernetria/pi-protocol/sdk/agent-session";
import { architectDefinition, reviewerDefinition, scoutDefinition, securityReviewerDefinition, workerDefinition } from "../src/roles/index.ts";
import type { AgentDefinition, AgentRole } from "../src/runtime/definition.ts";
import { agentSpecFor, protocolManifest, provideSpecFor } from "../src/runtime/manifest.ts";
import { createPiChildAgentSession } from "../src/runtime/pi-runner.ts";
import {
  parseAgentOutput,
  prepareAgentInput,
  type PreparedAgentInput,
  type RunAgentDependencies,
} from "../src/runtime/run-agent.ts";
import type { AgentOutputBase, AgentRequestBase } from "../src/types.ts";

export type AgentTeamDependencies = RunAgentDependencies;

function createManifestAgentExecutor<
  Request extends AgentRequestBase,
  Output extends AgentOutputBase,
>(
  definition: AgentDefinition<Request, Output>,
  overrides: AgentTeamDependencies,
): ProtocolAgentExecutor {
  const agent = agentSpecFor(definition.role);
  const provide = provideSpecFor(definition.role);
  const preparedStorage = new AsyncLocalStorage<PreparedAgentInput<Request>>();
  const sdkExecutor = createPiSdkAgentExecutorsFromManifest({
    ...protocolManifest,
    agents: { [definition.role]: agent },
  }, {
    createSession: (_agentName) => () => {
      const prepared = preparedStorage.getStore();
      if (!prepared) throw new Error(`Missing prepared invocation for ${definition.role}`);
      return createPiChildAgentSession(prepared, definition, agent, overrides.runner);
    },
    toPrompt: (input: unknown) => (input as PreparedAgentInput<Request>).prompt,
    toOutput: (_agentName: string, _agent: ProtocolAgentSpec) => (text: string, input: unknown) =>
      parseAgentOutput<Output>(text, input as PreparedAgentInput<Request>),
  })[definition.role];
  if (!sdkExecutor) throw new Error(`Manifest did not produce executor ${definition.role}`);

  return async (input, context) => {
    const prepared = await prepareAgentInput(
      definition,
      input as Request,
      agent,
      provide,
      overrides,
    );
    return preparedStorage.run(prepared, () => sdkExecutor(prepared, context));
  };
}

const definitions: Record<AgentRole, AgentDefinition<any, any>> = {
  scout: scoutDefinition,
  architect: architectDefinition,
  worker: workerDefinition,
  reviewer: reviewerDefinition,
  security_reviewer: securityReviewerDefinition,
};

export function createScoutAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createManifestAgentExecutor(scoutDefinition, overrides);
}

export function createArchitectAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createManifestAgentExecutor(architectDefinition, overrides);
}

export function createWorkerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createManifestAgentExecutor(workerDefinition, overrides);
}

export function createReviewerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createManifestAgentExecutor(reviewerDefinition, overrides);
}

export function createSecurityReviewerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createManifestAgentExecutor(securityReviewerDefinition, overrides);
}

export function createAgentExecutors(overrides: AgentTeamDependencies = {}): Record<string, ProtocolAgentExecutor> {
  return Object.fromEntries(
    Object.entries(definitions).map(([role, definition]) => [role, createManifestAgentExecutor(definition, overrides)]),
  );
}
