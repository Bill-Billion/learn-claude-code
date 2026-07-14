# s13 against the Pi 0.79.1 source

s13 maps to Pi's assembly path rather than one standalone class: Trust, Resources, Packages, Extensions, Agent Harness, Session, and shells converge before the first Prompt.

```text
resolve trust and resources
  -> build Agent Session services
  -> run one Agent Harness over one Session
  -> expose CLI modes and SDK methods
```

## Corresponding files

- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/print-mode.ts)

## The mapping

| s13 | Pi 0.79.1 |
| --- | --- |
| `createIntegratedHarnessRuntime()` | the assembly performed by `createAgentSession()` and `createAgentSessionRuntime()` |
| supplied Model, Tool registry, and Session | Agent Session services and `AgentHarness` dependencies |
| `prepareProjectTrust()` | `resolveProjectTrusted()` before final Resource loading |
| `createPackageRuntime()` | Package Manager selection followed by `ResourceLoader.reload()` |
| `extensionFactories` | Extension factories after Pi's module loader resolves paths |
| `MiniCoreRuntime` | the teaching facade over Agent Harness plus Agent Session state |
| `promptTemplates` / `invokePromptTemplate()` | loaded templates and explicit `expandPromptTemplate()` invocation |
| `IntegratedHarnessRuntime` | a host-facing Session facade with a course-specific Prompt queue |
| Print, JSON, RPC, and SDK helpers | CLI modes and direct Agent Session APIs around one runtime |

## Assembly order

Pi's `createAgentSession()` assembles Settings, Model selection, Session Manager, Package Manager, Resource Loader, Extensions, Tools, and `AgentSession`. The CLI's `AgentSessionRuntime` retains the services needed to replace or reload that Session while keeping mode-level ownership outside the Agent loop.

s13 makes the same dependency order explicit:

```text
Project Trust
  -> protected direct paths and project packages
  -> package Resource selection
  -> Extension factories, Skills, Prompt Templates
  -> MiniCoreRuntime and AgentMessage Session
  -> IntegratedHarnessRuntime and shells
```

The real Model and Tool registry are supplied once. Every shell delegates to the resulting runtime rather than constructing another loop.

## Trust, Resources, and Packages

Pi's `ResourceLoader.reload()` performs a pre-trust pass, resolves Project Trust, updates `SettingsManager.projectTrusted`, resolves package and direct Resource paths, then loads the final Extension set and other Resources.

The course preserves the observable boundary:

- Context candidates remain independent of Project Trust.
- User Resources and user packages remain available.
- Project Skills, Prompt Templates, direct Extensions, and project packages participate only after Trust.
- Package and direct Extension paths must match explicit course factories.
- Selected Prompt Templates are catalog data until explicitly invoked.

Pi dynamically loads Extension modules and obtains package lists from Settings. s13 receives both as host arguments. The explicit map makes eligibility and execution separate, which is useful for teaching but is not Pi's module-loading API.

## One AgentMessage Session and every shell

`AgentHarness` builds each Turn from Session Context, System Prompt, Tools, and Hooks, then appends rich Agent Messages back to the Session. s13 reuses the course implementation of those same contracts; Tool Calls and Tool Results remain structured `AgentMessage` objects.

`IntegratedHarnessRuntime` implements `prompt()`, `getState()`, and live `subscribe()`, so Print, JSON, RPC, and SDK access share one cumulative Session. Explicit Prompt invocation enters the same queue and Session as a normal Prompt.

The course transparently serializes concurrent `prompt()` and `invokePromptTemplate()` calls. Pi's `AgentSession.prompt()` instead requires an active-stream caller to choose `steer` or `followUp` behavior. Do not infer the course queue from Pi's public concurrency contract.

## Course-specific host policies

s13 expects the host to provide a Model, Tool registry, Resource source, Package entries, and Extension factories. Pi discovers and constructs more of these from user and project Settings.

The course also omits dynamic module loading, Package installation, Theme UI, Runtime replacement, reload, resume, compaction orchestration, steering, follow-up queues, abort controls, model switching, and the terminal editor. Those omissions do not change the core composition demonstrated by the tests.

`PI_PROJECT_TRUST` affects the course CLI's default policy, but the small CLI has no interactive Trust selector or persistent Store. Its default `ask` therefore leaves protected inputs off when a decision is required. This is a host limitation, not a different Project Trust rule.

## Suggested reading order

1. Start with `createAgentSession()` in `sdk.ts` and `createAgentSessionRuntime()`.
2. Follow `ResourceLoader.reload()` through Trust, Package resolution, and final Extension loading.
3. Read `AgentHarness.createTurnState()` and its loop handoff.
4. Follow `AgentSession.prompt()` through Prompt Template expansion and `before_agent_start`.
5. Read the rich-message append path in the Harness Session implementation.
6. Finish with Print mode and `AgentSession.subscribe()` to see two shells around the same assembled Session.
