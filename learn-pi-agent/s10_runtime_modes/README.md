# s10 · Runtime Modes

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the interactive, print/JSON, RPC, and SDK shells around one Agent Session runtime.

```text
                         +-> interactive
one MiniCoreRuntime -----+-> print (text or JSON)
one Session              +-> RPC
                         +-> SDK
```

## The problem

s09 has a real model-tool loop, Session Tree, Context Resources, and Extensions. A product still needs several ways to enter that system: a person uses an interactive terminal, a script wants one result, another process wants commands, and an application wants an API.

Building a separate Agent for every entry point would split Message history and configuration. A prompt sent through RPC would not exist in the interactive Session, and every new Tool or Extension behavior would need several implementations.

## The idea

s10 puts four shell families around one shared `MiniCoreRuntime` and one shared Session:

| Shell | Input | Output |
| --- | --- | --- |
| Interactive | a sequence of terminal-style prompts | a transcript |
| Print | one prompt | final text or JSONL lifecycle Events |
| RPC | `prompt` and `get_state` commands | correlated response objects |
| SDK | direct method calls | result objects, state, and Event callbacks |

The shell contract stays small:

```ts
export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void;
}
```

`createMiniCoreRuntime()` is asynchronous because it first hydrates Session metadata and the active Message Context. `MiniCoreRuntime.prompt()` then calls s09's `runExtensionTurn()`, captures and publishes real Agent Events, refreshes that Session snapshot, and records a successful Run result. Every shell delegates to that object.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s10
```

Or send one prompt directly through the CLI's Print shell:

```bash
npm run s10 -- "Use read_file to inspect package.json and report the pi-ai version."
```

The model response and Tool Calls can vary. The stable path is the same as s09: real Model, Extension Turn, active `read_file`, Session persistence. s10 changes only how callers enter the runtime and consume its result.

## How the code works

### 1. Keep cumulative state in one real Core

Callers first await `createMiniCoreRuntime()`. The factory reads Session metadata and the active Context, so a resumed Session immediately reports its ID, Messages, latest Assistant text, and existing User-Prompt count.

`MiniCoreRuntime.prompt()` increments a monotonic Prompt-attempt counter before delegating to `runExtensionTurn()`. It collects each `AgentEvent` through `onEvent` and sends a clone to every current subscriber while the Turn is running. After success it refreshes the Session snapshot and stores a cloned `MiniRunResult`:

```ts
const runtime = await createMiniCoreRuntime(options);
const result = await runtime.prompt(prompt);

console.log(result.runId);
console.log(runtime.getState());
```

If the Turn fails, the Runtime still refreshes any Messages already persisted by the loop, then rethrows the original error. `getState().turns` counts Prompt attempts, not only successful Results, and its number never moves backward when branching or compaction shortens the active Context. `getPrompts()` contains attempts submitted through this Runtime instance, including failures; `getRuns()` contains only attempts that produced a `MiniRunResult`.

### 2. Treat text and JSON as two Print outputs

`runPrintMode()` awaits `runtime.prompt()` and returns `finalText`. `runJsonMode()` also awaits the complete prompt, then serializes the captured lifecycle Events as JSONL.

The lesson's JSON helper is therefore post-run serialization, not a live Event stream. Real Pi's JSON branch subscribes before prompting and writes Events as they arrive.

### 3. Turn RPC commands into the same method calls

`runRpcMode()` supports `prompt` and `get_state`. It preserves an optional command ID so another process can correlate a response.

The teaching RPC `prompt` response waits for the Turn and includes the full `MiniRunResult` on success. If the Model, Tool loop, or Event observer fails, `runRpcMode()` catches the rejection and returns the same correlated response shape with `success: false` and an error string. Real Pi's protocol separates preflight acknowledgement from asynchronously emitted Session Events and supports many more commands.

### 4. Keep SDK and Interactive wrappers thin

`runInteractiveMode()` feeds prompts to the same runtime in order and formats a transcript. It is not a TUI; editor state, key bindings, and rendering are outside this lesson.

`createSdkSession()` exposes `prompt()`, `getState()`, and `subscribe()` by delegating to the same Core. `MiniCoreRuntime.subscribe()` receives cloned Events from `onEvent` while the underlying Turn is still running, before `prompt()` resolves. It is a live subscription rather than a replay of `result.events`. Unsubscribing removes the listener from later Events.

## Try it yourself

1. Preload a Session with one User/Assistant pair, await `createMiniCoreRuntime()`, and inspect state before sending a new Prompt.
2. Call Print, JSON, RPC, and SDK in sequence. Compare the monotonic `getState().turns` and `getPrompts()` with the successful-only `getRuns()`.
3. Subscribe through `createSdkSession()` and inspect `getRuns().length` inside the callback. Live Events arrive before the current successful Run is stored.
4. Make one RPC Prompt fail, then send another Prompt. The first response should have `success: false`, the refreshed Session should retain already-persisted Messages, and the second Run ID should use the next attempt number.

## Wiring into the main line

| Boundary | s09 | s10 |
| --- | --- | --- |
| Core execution | `runExtensionTurn()` | wrapped by `MiniCoreRuntime.prompt()` |
| Session | supplied to one Turn | shared across every shell call |
| Events | callback during one Turn | captured per Run and published live to SDK subscribers |
| Text output | caller reads the final Message | Print and Interactive format it |
| Machine output | result object only | JSONL, RPC responses, or SDK objects |
| State hydration | caller already holds the Session | async factory reads metadata and active Context |
| Attempt state | one Turn at a time | monotonic attempts plus successful-only Run results |

## Against the Pi source

The shared runtime, Session hydration, mode dispatch, Print text/JSON branches, RPC response layer, and SDK Session API map to Pi 0.79.1. The course SDK subscription is live like Pi's Agent Session subscription. The course still batches JSON output after each Prompt and makes RPC `prompt` wait for the full Run or return a failure response; Pi acknowledges Prompt preflight separately while JSON and RPC Session Events can continue during work.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## Next up

[s11 · Project Trust](../s11_project_trust/) decides which project-local inputs may load before one of these runtime shells starts. It is a loading gate, not a permission system or sandbox.
