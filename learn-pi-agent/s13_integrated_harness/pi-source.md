# s13 Against the Pi Source

s13 maps not to one standalone class but to the composite chain in Pi that runs from resource loading to the agent loop. As before, this unit is pinned to the repository's `@earendil-works/pi-coding-agent` 0.79.1 at commit `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`.

## The files

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/session-manager.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)

Specific anchors:

```text
agent-loop.ts:31-67                 agentLoop() takes context, tools, and the loop config
agent-loop.ts:279-303               provider requests carry systemPrompt, messages, and tools
agent-loop.ts:564-628               beforeToolCall, tool dispatch, and the blocked result
agent-harness.ts:332-359            session.buildContext() and turn state
agent-harness.ts:367-446            systemPrompt, tools, and beforeToolCall wired into the agent loop
agent-harness.ts:488-512            agent messages written back to the session
agent-harness.ts:571-596            before_agent_start mutating the system prompt
harness/session/session.ts:114-144  buildContext() and appendMessage()
project-trust.ts:45-112             the project trust decision order
resource-loader.ts:331-468          trust, package resolve, extension/resource load
package-manager.ts:885-921          project/user packages and local resources gathered
extensions/runner.ts:867-905        tool_call handlers run in load order
extensions/runner.ts:980-1042       the before_agent_start handler chain
extensions/runner.ts:1052-1090      the resources_discover handler chain
agent-session.ts:404-430            tool_call events wired to the agent's beforeToolCall
agent-session.ts:1099-1125          before_agent_start runs before the prompt
session-manager.ts:950-984          messages appended to the JSONL session tree
sdk.ts:166-330                      createAgentSession() assembling the SDK session
```

## The mapping

| s13 | Pi |
| --- | --- |
| `createIntegratedHarnessRuntime()` | coding-agent's session/service/runtime assembly layer |
| `resolveProjectTrusted()` | trust resolution in `project-trust.ts` |
| `resolvePiPackages()` | `DefaultPackageManager.resolve()` |
| path-to-factory map | the set of extension modules once module loading completes |
| `createExtensionTurnState()` | resource loader, system prompt builder, and `before_agent_start` |
| provider adapter | the context handoff from `AgentHarness.createTurnState()` to `agentLoop()` |
| `runner.emitToolCall()` | the extension runner's `tool_call` event |
| `runHookedToolLoop()` | the tool loop and hook dispatch in `agent-loop.ts` |
| tagged JSON session adapter | Pi persisting rich `AgentMessage` objects as session entries |
| `MiniRuntime` shells | coding-agent CLI modes and the SDK as shells around one session |

## What this unit simplifies

Real Pi dynamically loads extension modules, merges settings, and handles package install paths, resource precedence, name collisions, reload, compaction, model selection, and the terminal UI. s13 keeps only this observable chain:

```text
trust
  -> package/resource resolution
  -> extension registration
  -> turn state
  -> provider + hooked tool loop
  -> session persistence
  -> runtime shell
```

Files and extension modules are all supplied by in-memory fixtures. The path-to-factory map stands in for modules already loaded by the host; the s12 resolver only decides which paths are eligible to enter the runner. Project trust decides whether project-local paths participate in selection at all.

s07's message contract is narrower than Pi's `AgentMessage`, so s13 stores complete assistant/tool-result objects as tagged JSON. That's a course-internal adapter, not a replica of Pi's session file format.

## Suggested reading order

Start with `createTurnState()` and `runLoop()` in `agent-harness.ts` — that's where you see how session context, system prompt, tools, and hooks enter the same loop.

Then read `reload()` in `resource-loader.ts` to confirm trust takes effect before package and project extension resolution. Follow up with the extension runner's `emitBeforeAgentStart()`, `emitResourcesDiscover()`, and `emitToolCall()`.

Finish with the event forwarding in `agent-session.ts` and the append path in `session-manager.ts`. They correspond to the parts of s13 where the loop result gets written back to the session, and where different shells share the same runtime state.
