import type { ProtocolAgentExecutor, ProtocolInvocationContext } from "@kybernetria/pi-protocol";
import { architectDefinition, reviewerDefinition, securityReviewerDefinition, workerDefinition } from "../src/roles/index.ts";
import { piChildAgentRunner } from "../src/runtime/pi-runner.ts";
import { runAgent, type RunAgentDependencies } from "../src/runtime/run-agent.ts";
import type { ArchitectRequest, ReviewerRequest, SecurityReviewerRequest, WorkerRequest } from "../src/types.ts";

export type AgentTeamDependencies = Partial<RunAgentDependencies>;

function dependencies(overrides: AgentTeamDependencies): RunAgentDependencies {
  return { runner: overrides.runner ?? piChildAgentRunner, ...overrides };
}

export function createArchitectAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return (input: unknown, context?: ProtocolInvocationContext) => runAgent(architectDefinition, input as ArchitectRequest, context, dependencies(overrides));
}

export function createWorkerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return (input: unknown, context?: ProtocolInvocationContext) => runAgent(workerDefinition, input as WorkerRequest, context, dependencies(overrides));
}

export function createReviewerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return (input: unknown, context?: ProtocolInvocationContext) => runAgent(reviewerDefinition, input as ReviewerRequest, context, dependencies(overrides));
}

export function createSecurityReviewerAgentExecutor(overrides: AgentTeamDependencies = {}): ProtocolAgentExecutor {
  return (input: unknown, context?: ProtocolInvocationContext) => runAgent(securityReviewerDefinition, input as SecurityReviewerRequest, context, dependencies(overrides));
}

export function createAgentExecutors(overrides: AgentTeamDependencies = {}): Record<string, ProtocolAgentExecutor> {
  return {
    architect: createArchitectAgentExecutor(overrides),
    worker: createWorkerAgentExecutor(overrides),
    reviewer: createReviewerAgentExecutor(overrides),
    security_reviewer: createSecurityReviewerAgentExecutor(overrides),
  };
}
