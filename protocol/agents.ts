import { AsyncLocalStorage } from "node:async_hooks";
import type { ProtocolAgentExecutor } from "@kybernetria/pi-protocol/core";
import { createPiSdkAgentExecutorsFromProfiles } from "@kybernetria/pi-protocol/sdk/agent-session";
import { architectDefinition, reviewerDefinition, scoutDefinition, securityReviewerDefinition, workerDefinition } from "../src/roles/index.ts";
import type { AgentDefinition, AgentRole } from "../src/runtime/definition.ts";
import { agentProfileFor, agentProfiles, protocolDefinition, provideContractFor } from "../src/runtime/manifest.ts";
import { createPiChildAgentSession } from "../src/runtime/pi-runner.ts";
import {
  parseAgentOutput,
  prepareAgentInput,
  type PreparedAgentInput,
  type RunAgentDependencies,
} from "../src/runtime/run-agent.ts";
import type { AgentOutputBase, AgentRequestBase } from "../src/types.ts";

export type AgentTeamDependencies = RunAgentDependencies;

function createProfileAgentExecutor<
  Request extends AgentRequestBase,
  Output extends AgentOutputBase,
>(
  definition: AgentDefinition<Request, Output>,
  overrides: AgentTeamDependencies,
): ProtocolAgentExecutor {
  const profile = agentProfileFor(definition.role);
  const provide = provideContractFor(definition.role);
  const preparedStorage = new AsyncLocalStorage<PreparedAgentInput<Request>>();
  const sdkExecutor = createPiSdkAgentExecutorsFromProfiles(protocolDefinition, agentProfiles, {
    agentByProvide: { [definition.role]: definition.role },
    createSessionForAgent: () => () => {
      const prepared = preparedStorage.getStore();
      if (!prepared) throw new Error(`Missing prepared invocation for ${definition.role}`);
      return createPiChildAgentSession(prepared, definition, profile, overrides.runner);
    },
    toPromptByAgent: () => (input: unknown) => (input as PreparedAgentInput<Request>).prompt,
    toOutputByAgent: () => (text: string, input: unknown) =>
      parseAgentOutput<Output>(text, input as PreparedAgentInput<Request>),
  })[definition.role];
  if (!sdkExecutor) throw new Error(`Private profile did not produce executor ${definition.role}`);

  return async (input, context) => {
    const prepared = await prepareAgentInput(definition, input as Request, profile, provide, overrides);
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
  return createProfileAgentExecutor(scoutDefinition, overrides);
}
export function createArchitectAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createProfileAgentExecutor(architectDefinition, overrides);
}
export function createWorkerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createProfileAgentExecutor(workerDefinition, overrides);
}
export function createReviewerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createProfileAgentExecutor(reviewerDefinition, overrides);
}
export function createSecurityReviewerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return createProfileAgentExecutor(securityReviewerDefinition, overrides);
}

export function createAgentExecutors(overrides: AgentTeamDependencies = {}): Record<string, ProtocolAgentExecutor> {
  return Object.fromEntries(
    Object.entries(definitions).map(([role, definition]) => [role, createProfileAgentExecutor(definition, overrides)]),
  );
}
