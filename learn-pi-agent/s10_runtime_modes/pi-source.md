# Pi Source Map for s10

s10 maps to Pi's runtime mode layer.

```text
create AgentSessionRuntime
  -> app mode dispatch
  -> interactive / print / json / rpc / sdk
  -> same AgentSession and event stream
```

## Mapped files

- [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/main.ts)
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/print-mode.ts)
- [`packages/coding-agent/src/modes/rpc/rpc-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`packages/coding-agent/docs/json.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/json.md)
- [`packages/coding-agent/docs/rpc.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/rpc.md)
- [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/sdk.md)

Specific anchors:

```text
README.md:20-24                  Pi's positioning and the four runtime modes
README.md:536-539                the CLI mode table
main.ts:98-109                   resolveAppMode()
main.ts:577-705                  createRuntime and AgentSessionRuntime creation
main.ts:767-804                  appMode dispatch to rpc / interactive / print-json
agent-session-runtime.ts:67-74   AgentSessionRuntime holds the current session and cwd-bound services
agent-session-runtime.ts:400-424 createAgentSessionRuntime()
print-mode.ts:32-45              runPrintMode() receives the AgentSessionRuntime
print-mode.ts:71-108             print/json mode rebinds the session and subscribes to events
print-mode.ts:111-127            calling session.prompt()
print-mode.ts:129-145            text mode prints the last assistant text
rpc-mode.ts:312-360              RPC mode binds the extension UI context and subscribes to session events
rpc-mode.ts:390-411              the prompt command calls session.prompt()
rpc-mode.ts:442-457              get_state reads state from the same session
sdk.ts:166-184                   createAgentSession() builds the base objects a session needs
docs/sdk.md:16-38                SDK quick start: subscribe + prompt
docs/sdk.md:70-118               the AgentSession API shape
```

## Mapping

| s10 | Pi |
| --- | --- |
| `MiniCoreRuntime` | a minimal fusion of `AgentSession` + `AgentSessionRuntime` |
| `MiniCoreRuntime.prompt()` | `AgentSession.prompt()` |
| `MiniRuntimeEvent` | `AgentSessionEvent` / `AgentEvent` |
| `runPrintMode()` | the text branch of `modes/print-mode.ts` |
| `runJsonMode()` | the json branch of `modes/print-mode.ts` |
| `runRpcMode()` | `modes/rpc/rpc-mode.ts` |
| `createSdkSession()` | using `session` directly after `createAgentSession()` |
| `runInteractiveMode()` | a bare-bones shadow of `InteractiveMode.run()` |

## What s10 simplifies

Real Pi's runtime modes carry a lot more engineering detail:

```text
real stdin/stdout JSONL framing
the TUI editor and keyboard shortcuts
extension UI context
resubscribing to events after session replacement
stdout backpressure
signal cleanup
model / thinking level / scoped model controls
RPC commands like steer, follow_up, abort, fork, switch_session
the RPC prompt-accepted response separated from the subsequent event stream
```

s10 implements none of these. It keeps a single invariant:

```text
mode shells own no agent state of their own
```

The event vocabulary is simplified too: the mini uses four event kinds — `session / agent_start / message / agent_end`. Of these, `message` doesn't exist in Pi (Pi has `message_start / message_update / message_end`), and `session` corresponds to the session header that JSON mode writes out first (`print-mode.ts:112-117`), which is not an event. s13 wires these shells back onto the real event stream from s04/s05.

As long as the invariant holds, shells can be added or removed freely. print can be short, interactive can be elaborate, RPC can be machine-friendly, SDK can embed in an application. What they share is one session/runtime.

## How it connects to earlier units

```text
s03 Provider Events      JSON mode emits events
s06 Turn State           a runtime prompt turn uses one state snapshot
s07 Session Tree         the runtime owns continuing and switching the current session
s08 Context Resources    the runtime loads cwd-bound resources at creation
s09 Extension Runtime    each mode binds extensions according to its own UI capability
```

This is also one of Pi's important design points: the shells may differ, but core state and the event protocol stay as uniform as possible.

## Suggested reading order

Start with `resolveAppMode()` and the final dispatch in `main.ts`. You can see that CLI flags only decide the entry shape — they don't spin up a separate agent.

Then read `print-mode.ts`. text and JSON live in the same function; the difference boils down to text taking the last answer while JSON subscribes to events and prints them line by line.

Finish with `rpc-mode.ts` and `docs/sdk.md`. RPC suits non-Node processes and cross-process integration; the SDK suits TypeScript programs embedding directly. Similar goals, different boundaries.
