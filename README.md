# pi-dev

A Pi extension exposing three isolated software-development agents through **pi-protocol 0.2.0**:

- `pi_dev.architect` — read-only analysis and planning
- `pi_dev.worker` — edits the requested cwd directly and runs tests
- `pi_dev.reviewer` — source-read-only review with constrained git/test execution
- `pi_dev.security_reviewer` — source-read-only security review with threat modeling and constrained git/test execution

There is intentionally no orchestrator or git-worktree management. Callers compose the roles themselves.

## Install

```bash
npm install /path/to/pi-dev
```

Add the package to Pi's packages/extensions configuration as appropriate for your installation. The package declares `pi.extensions: ["./extension.ts"]`; loading it registers the node on the shared protocol fabric. It does not register package-specific Pi tools.

## Invoke

Use the generic `protocol` tool:

```json
{"target":"pi_dev.architect","input":{"task":"Plan token refresh support","cwd":"/repo","constraints":["Preserve the public API"],"outputDepth":"detailed"}}
```

```json
{"target":"pi_dev.worker","input":{"task":"Implement token refresh support","cwd":"/repo","plan":["Add refresh flow","Add tests"],"acceptanceCriteria":["Existing and new tests pass"]}}
```

```json
{"target":"pi_dev.reviewer","input":{"task":"Review token refresh support","cwd":"/repo","range":"main...HEAD","acceptanceCriteria":["No token leakage"],"testExpectations":["Unit tests pass"]}}
```

```json
{"target":"pi_dev.security_reviewer","input":{"task":"Review token refresh support for security risks","cwd":"/repo","range":"main...HEAD","securityFocus":["token handling","authorization"]}}
```

The equivalent programmatic call is:

```ts
const result = await fabric.invoke({
  nodeId: "pi_dev",
  provide: "architect",
  input: { task: "Plan the change", cwd: "/repo" },
});
if (!result.ok) console.error(result.error.code, result.error.message);
```

All roles return strict JSON plus a human-readable `message`. See `pi.protocol.json` for complete input/output schemas.

## Composition

A caller can invoke:

1. `architect` to obtain an ordered plan and acceptance criteria.
2. `worker` with that plan and criteria.
3. `reviewer` and/or `security_reviewer` against the resulting diff/range.
4. Optionally, `worker` again with the review findings as `context` and acceptance criteria.

Each invocation creates a fresh in-memory child AgentSession bound to the requested cwd.

## Safety

- Cwds are resolved to canonical existing directories before session creation.
- Architect gets only `read`, `grep`, `find`, and `ls`.
- Worker gets read/search tools plus `bash`, `edit`, and `write`, and modifies the cwd directly.
- Reviewer has no general shell or mutation tool. `review_command` uses no shell and only supports constrained git status/diff/show and standard npm/pnpm/yarn/bun test execution. Tests can still create normal build/cache artifacts.
- Child sessions load no extensions, skills, prompt templates, or themes, preventing recursive self-loading. Project context files may still be read.
- Caller cancellation and timeouts abort the child session. Large prompt and reviewer-command output is truncated with diagnostics; oversized model responses are rejected rather than returning untrusted partial JSON.

Review tasks and worker tasks can execute project code. Only use trusted repositories and review commands/scripts.

## Configuration

Every request may set `model`, `thinkingLevel`, and `timeoutMs`. If omitted, configuration is resolved in this order:

- Model: `PI_DEV_<ROLE>_MODEL`, then `PI_DEV_MODEL`, then Pi's configured/default available model.
- Thinking: request value, `PI_DEV_<ROLE>_THINKING`, `PI_DEV_THINKING`, then the role default.
- Timeout: 10 minutes (maximum accepted request value: 1 hour).

Limits can be configured with `PI_DEV_MAX_PROMPT_CHARS` and `PI_DEV_MAX_RESPONSE_CHARS`.

## Add a fourth agent

1. Add its request/output types in `src/types.ts`.
2. Add a declarative `AgentDefinition` under `src/roles/`, including tool allowlists, prompt, output contract, and validator.
3. Export the definition from `src/roles/index.ts`.
4. Export a thin agent executor from `protocol/agents.ts` that calls the shared `runAgent`; add its key to `createAgentExecutors()`.
5. Add the agent metadata under `agents` in the manifest, then add one manifest provide whose agent execution key exactly matches that executor key.
6. If needed, add a narrowly scoped custom-tool factory to `src/runtime/pi-runner.ts`; do not broaden another role's allowlist.
7. Add registration, contract, restriction, cancellation, and malformed-output tests, then run `npm run typecheck && npm test`.

The shared runtime requires no role switch statement.

## Development

```bash
npm install
npm run typecheck
npm test
```
