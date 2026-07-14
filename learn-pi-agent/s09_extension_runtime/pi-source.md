# s09 against the Pi 0.79.1 source

s09 maps to Pi's Extension loading, registration API, Event runner, and Agent Session integration.

```text
Extension factory -> Extension record -> ExtensionRunner -> Harness boundaries
```

## Corresponding files

- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/types.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/extensions.md)

## The mapping

| s09 | Pi 0.79.1 |
| --- | --- |
| `MiniExtensionFactory` | `ExtensionFactory` |
| `MiniExtensionAPI` | the teaching subset of `ExtensionAPI` |
| `LoadedExtension` | `Extension` registration record |
| `loadMiniExtensions()` | factory loading plus `createExtensionAPI()` |
| `MiniExtensionRunner` | `ExtensionRunner` |
| `emitBeforeAgentStart()` | `ExtensionRunner.emitBeforeAgentStart()` |
| `emitResourcesDiscover()` | `ExtensionRunner.emitResourcesDiscover()` |
| `emitToolCall()` | `ExtensionRunner.emitToolCall()` |
| `createExtensionToolHooks()` | Agent Session wiring from `tool_call` to `beforeToolCall` |
| `mergeExtensionTools()` | registered Tools entering the Agent Tool set |
| `runCommand()` | a small registered Command invocation surface |

## Registration versus execution

Pi's `createExtensionAPI()` writes Event Handlers, Tools, and Commands into the current Extension record. The shared runtime has unavailable action stubs during initial loading, making the registration phase distinct from live execution.

s09 preserves that central rule. Its factories are already supplied by the caller, while Pi dynamically imports files and supports both synchronous and asynchronous initialization.

## Event integration

`before_agent_start` Handlers are chained in load order. Pi collects their Custom Messages and adds them to the Agent's input Messages; s09 materializes the same Message shape and persists it through the Session before creating the live Turn snapshot.

`tool_call` is installed as the Agent's Before Tool Hook in Pi's `AgentSession`. The lesson makes that connection explicit through `createExtensionToolHooks()`, so blocking still produces the normal Tool Result lifecycle. Its composition helper applies caller argument rewrites before Extension policy, ensuring the policy checks the values that would actually execute.

`resources_discover` returns paths tagged with the reporting Extension path in both implementations. That provenance survives discovery even when the Resource Loader later merges many sources.

## Composition with earlier lessons

The Extension layer does not replace previous boundaries:

```text
s02 Registry          receives Extension Tools
s05 Tool Hooks        receives tool_call policy
s06 AgentMessage      carries before_agent_start Custom Messages
s08 Resource Loader   receives discovered Skill and Prompt paths
```

`runExtensionTurn()` prepares those inputs and then delegates to the same real Harness and Provider path.

## Course scope

Pi's Extension API also supports many more Events, UI components, keyboard shortcuts, CLI flags, Message renderers, Provider registration, Session actions, reload, and stale-context protection. Its loader reports per-Extension errors rather than using the course's smaller fail-fast checks.

s09 does not dynamically import source files or implement an interactive slash-command parser. It proves Tool and Command registration, three Event paths, provenance, Session insertion, and composition with the existing Loop.

## Suggested reading order

1. Read `ExtensionFactory`, `ExtensionAPI`, and `Extension` in `types.ts`.
2. Read `createExtensionAPI()` in `loader.ts` to see registrations written into a record.
3. Follow the three matching emit methods in `runner.ts`.
4. Finish in `agent-session.ts`, where `tool_call` becomes a Tool Hook and `before_agent_start` Messages join the Agent input.
