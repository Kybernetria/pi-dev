# pi-dev

A Pi extension exposing five isolated software-development agents through **pi-protocol 0.2.0**:

- `pi_dev.scout` — fast, concise, read-only codebase exploration
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
{"target":"pi_dev.scout","input":{"task":"Locate the token refresh flow","cwd":"/repo","scope":["src"],"questions":["Where are refresh tokens stored?","Which handler starts renewal?"]}}
```

```json
{"target":"pi_dev.architect","input":{"task":"Plan token refresh support","cwd":"/repo","constraints":["Preserve the public API"]}}
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

1. `scout` for quick file locations and code-path context when the implementation area is not yet known.
2. `architect` to obtain an ordered plan and acceptance criteria.
3. `worker` with that plan and criteria.
4. `reviewer` and/or `security_reviewer` against the resulting diff/range.
5. Optionally, `worker` again with the review findings as `context` and acceptance criteria.

Ephemeral invocations create a fresh in-memory child AgentSession bound to the requested cwd. Protocol `continue`/`end` session controls reuse and dispose the same role session through the standard SDK adapter.

## Safety

- Cwds are resolved to canonical existing directories before session creation.
- Scout gets only `read`, `grep`, `find`, and `ls`; it is instructed to search narrowly and return concise, verified findings.
- Architect gets the same read-only file tools plus `protocol`; its caller-side protocol policy allows only `pi_dev.scout`.
- Worker gets read/search tools plus `bash`, `edit`, `write`, and restricted `protocol` access to `pi_dev.scout`; it modifies the cwd directly.
- Reviewers have no general shell or mutation tool. They receive restricted `protocol` access to `pi_dev.scout`; `review_command` uses no shell and only supports constrained git status/diff/show and standard npm/pnpm/yarn/bun test execution. Tests can still create normal build/cache artifacts.
- Child sessions load no extensions, skills, prompt templates, or themes, preventing recursive self-loading. The restricted protocol tool is injected explicitly; project context files may still be read.
- `pi.protocol.json` is the sole authority for prompts, exact tool allowlists, model defaults, thinking defaults, schemas, protocol access, and effects. Role modules only shape role-specific request details.
- Agent execution goes through the standard Pi SDK protocol adapter, including session continuation and model/input/delta/output runtime telemetry.
- Caller cancellation aborts the child session. Agent calls have no internal wall-clock deadline, so substantial work is not discarded merely for taking longer than expected. Large prompt and reviewer-command output is truncated with diagnostics; oversized model responses are rejected rather than returning untrusted partial JSON.

Review tasks and worker tasks can execute project code. Only use trusted repositories and review commands/scripts.

## Configuration

Every request may set `model` and `thinkingLevel`. If omitted, configuration is resolved in this order:

- Model: request value, `PI_DEV_<ROLE>_MODEL`, `PI_DEV_MODEL`, then the role default. Scout uses `openai-codex/gpt-5.3-codex-spark`; architect, worker, reviewer, and security reviewer use `openai-codex/gpt-5.6-sol`.
- Thinking: request value, `PI_DEV_<ROLE>_THINKING`, `PI_DEV_THINKING`, then the role default. Worker uses `medium`; all other roles use `high`.

Agent calls do not impose an internal wall-clock timeout. Callers retain explicit cancellation through the protocol invocation signal. Limits can be configured with `PI_DEV_MAX_PROMPT_CHARS` and `PI_DEV_MAX_RESPONSE_CHARS`.

## Add another agent

1. Add its request/output types in `src/types.ts`.
2. Add a minimal `AgentDefinition` under `src/roles/` that only shapes role-specific request details.
3. Export the definition from `src/roles/index.ts` and add it to the definition map in `protocol/agents.ts`.
4. Declare the agent's prompt, exact tools, model/thinking defaults, protocol access, and complete schemas/effects in `pi.protocol.json`; do not duplicate them in role code.
5. If needed, add a narrowly scoped custom-tool factory to `src/runtime/pi-runner.ts`; do not broaden another role's manifest allowlist.
6. Add registration, contract, restriction, telemetry, session, cancellation, and malformed-output tests, then run `npm run typecheck && npm test`.

The shared runtime derives operational behavior from the resolved manifest and requires no role switch statement.

## Development

```bash
npm install
npm run typecheck
npm test
```
