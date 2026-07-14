# s10 against the Pi 0.79.1 source

s10 maps four access shells onto one cumulative Agent Session runtime.

```text
AgentSessionRuntime
  -> Interactive
  -> Print: text or JSON
  -> RPC
  -> SDK AgentSession API
```

## Corresponding files

- [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/main.ts)
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)
- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/print-mode.ts)
- [`packages/coding-agent/src/modes/rpc/rpc-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`packages/coding-agent/docs/json.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/json.md)
- [`packages/coding-agent/docs/rpc.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/rpc.md)
- [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/sdk.md)

## The mapping

| s10 | Pi 0.79.1 |
| --- | --- |
| `MiniCoreRuntime` | a teaching facade over the shared Agent Session runtime |
| one supplied Session | the current Session owned by `AgentSessionRuntime` |
| async `createMiniCoreRuntime()` | constructing a Session host from existing metadata and Context |
| monotonic `promptCount` | course attempt state that does not shrink with active Context |
| `getPrompts()` / `getRuns()` | submitted attempts in this host / successful result snapshots |
| `runInteractiveMode()` | `InteractiveMode` |
| `runPrintMode()` | text branch of `runPrintMode()` |
| `runJsonMode()` | JSON branch of `runPrintMode()` |
| `runRpcMode()` | the command/response core of RPC mode |
| `createSdkSession()` | the direct Agent Session API created by `createAgentSession()` |
| `MiniRuntime.getState()` | the teaching subset of Session state exposed to shells |
| `MiniRuntime.subscribe()` | the live Agent Session Event subscription |
| captured `AgentEvent[]` | the per-Run snapshot of the existing Event protocol |

## One runtime and Session

Pi's `main.ts` resolves the application mode after constructing the services and Runtime factory needed to create the current Agent Session. Interactive, Print/JSON, and RPC receive that shared Runtime host instead of constructing separate Agent loops.

The SDK is the programmatic entry: `createAgentSession()` builds the same kinds of Model, Session Manager, Resource Loader, Tools, and Extensions without a CLI presentation layer. s10 puts all four access styles behind one small `MiniRuntime` interface so their shared state is directly testable.

The course factory first reads Session metadata and active Context, so resumed Messages are visible before a Prompt. Its `turns` value is a teaching host's monotonic Prompt-attempt count initialized from existing User Messages. Run IDs use that counter even if branch navigation or compaction later shortens the active Context. Failed attempts remain in `getPrompts()` but enter `getRuns()` only when they produce a Result.

## Shell behavior

Pi's Print mode has two output branches. Text reads the final Assistant Message after prompting; JSON subscribes to the Session and writes the Session header and Events. RPC subscribes to the same Session while translating JSON commands such as `prompt` and `get_state`.

The course exposes Print text and JSON as separate helpers, and its RPC command table contains only `prompt` and `get_state`. Interactive returns a transcript instead of implementing Pi's terminal UI. The SDK wrapper delegates `subscribe()` to the Core, so callbacks receive Events while `prompt()` is still running.

Course RPC waits for the whole Prompt. A rejection becomes a correlated `success: false` response, after the Core attempts to refresh any Session Messages already persisted by the failed Turn. Pi RPC instead emits its authoritative Prompt response after preflight and lets Session Events continue independently.

## Event timing differences

Two machine-facing helpers keep intentionally simpler timing:

```text
course JSON: await prompt -> serialize captured Events
course SDK:  subscribe -> receive live Events while prompt runs
course RPC:  await prompt -> return full Run result or failure response
```

The course SDK now matches Pi's live Agent Session subscription. The course JSON helper is still post-completion serialization, while Pi's Print JSON branch subscribes before prompting. The course RPC `prompt` waits for a full Run result or catches the rejection; Pi RPC acknowledges a Prompt after preflight while Session Events continue independently.

## Course scope

The real runtime also supports Session replacement, resume, fork, tree navigation, steering, follow-up, abort, model and thinking-level changes, Extension UI binding, signal handling, output backpressure, and many RPC commands.

s10 keeps the real s09 model-tool path and Session persistence, but narrows presentation to four shell families and a small cumulative state object. Its Prompt-attempt counter and successful-only Run snapshots are course observability fields, not a copy of Pi's complete Session state model. It introduces no second Agent core.

## Suggested reading order

1. Read `resolveAppMode()` and the final dispatch in `main.ts`.
2. Read `runPrintMode()`, comparing its text and JSON branches.
3. Follow RPC `rebindSession()`, Session subscription, `prompt`, and `get_state`.
4. Read `createAgentSession()` in `sdk.ts`.
5. Compare those boundaries with `MiniCoreRuntime` and the four lesson shell families.
