# s13 · Integrated Harness

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s12](../s12_pi_package/README.md) · [Contents](../README.md)

> In one sentence: s13 writes no new mechanisms — it joins the public interfaces of the first 12 units into one runnable request chain. If it all connects, the boundaries were drawn right.
>
> Where this sits in Pi: the product-layer orchestration of `pi-coding-agent` (where agent-harness, resource loader, session, and modes converge).

→ Integration isn't adding features — it's acceptance testing: if two parts can only cooperate by digging through each other's internals, the boundary was drawn wrong
→ The whole chain needs exactly three pieces of "glue": an adapter around the provider, a field mapping between hooks and extensions, and tagged JSON encoding for the session
→ The debt s10 left gets paid off here: a real core plugs into four shells on nothing but the `prompt()/getState()` interface

---

## The problem

Units s01 through s12 each raised one part: the tool loop in s05 (tool hooks), sessions in s07 (session tree), resources in s08 (context resources), extensions in s09 (extension runtime), shells in s10 (runtime modes), the loading boundary in s11 (trust), distribution in s12 (package). Every part has its own tests, but no single chain proves these interfaces actually mesh.

This is exactly where harness designs tend to fall over: every module looks clean in isolation, then integration reveals that A needs to reach into B's internals to cooperate. So s13 sets itself one rule: **adaptation and orchestration only, no new implementations**. The tool loop is still executed by s05, sessions are still stored by s07, and resource, extension, trust, package, and mode each reuse the public interfaces of s08–s12. Wherever things don't connect, only one thin layer of glue is allowed — and each piece of glue has to be able to explain why the original interface doesn't have this.

## The idea

One `prompt()` call walks this chain:

```text
prompt
  -> s11 trust:      resolveProjectTrusted() / loadProjectInputs()
  -> s12 package:    resolvePiPackages() computes resource and extension paths
  -> s09 extension:  loadMiniExtensions() + createExtensionTurnState()
  -> s07 session:    append the user message, take the current branch
  -> glue 1 adapter: inject the session branch and systemPrompt into the provider
  -> s05 tool loop:  runHookedToolLoop() runs the tool loop
  -> glue 2 mapping: s09's tool_call handler wired to s05's beforeToolCall
  -> glue 3 encoding: assistant/toolResult written back to s07 as tagged JSON
  -> s10 shell:      print / json / rpc / sdk consume the same runtime
```

`createIntegratedHarnessRuntime()` resolves trust, project inputs, package resources, and extension factories at initialization. Every `prompt()` rebuilds the turn state, so the current session branch, AGENTS.md, skills, prompt templates, and extension hooks all enter the same turn.

What this unit produces is a deterministic, offline teaching harness: the provider and files all come from in-memory fixtures — no model API, no network, no real shell, no project filesystem.

## Run it first

```bash
npm run session:s13
```

Output:

```text
Session: s13-demo
Final text: Integrated harness ready.
Events: session -> agent_start -> message -> agent_end
Stored messages: 2
```

Four lines from four parts: the session id comes from s07's session tree, the final text made it through s05's tool loop, the events are the s10 shell's event projection, and the stored message count is what got written back to s07. One chain, four origins.

## How the code works

### Glue 1: why the provider gets wrapped in an adapter

s05's loop only manages the assistant and tool-result messages produced within the current turn. It doesn't read s07, and it knows nothing about the system prompt s08 generates — that's s05's boundary, not a defect. s13 wraps the provider in one layer:

```ts
provider.stream({
  ...loopContext,
  messages: [...sessionPrefix, ...extensionMessages, ...context.messages],
  systemPrompt,
});
```

The first request sees the current session branch; after tools execute, s05 puts the new messages into `loopContext.messages`, so the next provider request sees both the history and this turn's results. There is still exactly one tool loop — s05's.

### Glue 2: how an extension blocks tool execution

s09's `tool_call` handler and s05's `beforeToolCall` already return the same shape, so s13 only maps fields:

```ts
beforeToolCall: ({ toolCall, args }) =>
  runner.emitToolCall({ toolName: toolCall.name, input: args })
```

When a handler returns `{ block: true, reason }`, s05 doesn't dispatch the local tool; it produces a structured tool result with `isError: true` instead, which the provider can read on its next turn. The two units' interfaces connect in one line because both were implemented, back in their own chapters, against the same Pi semantics (the hook protocol in `agent-loop.ts`).

### Glue 3: why the session stores tagged JSON

s07's teaching contract simplifies message content down to a string, while the assistant/tool-result messages from s03–s05 also carry tool call ids, arguments, error flags, and timestamps. s13 listens for s05's `message_end` events, encodes each complete message as a prefixed JSON string and writes it into s07 immediately, then decodes when building the next turn's provider context. No widening of s07's API, no loss of tool-call fields. Even if a tool has already executed and a later provider request fails, the completed assistant and tool-result records remain in the append-only session, available for audit.

User messages are still stored as plain text. s10's `MiniRunResult.messages` projects only user messages and text-bearing assistant messages; the full record lives in the s07 session tree.

### Trust and extension factories

Package extension paths are decided by s12's resolver; project packages and `.pi/extensions` additionally pass through s11's trust. `extensionFactories` is an in-memory path-to-factory map, standing in for "modules already loaded":

```ts
extensionFactories: {
  "/packages/review/extensions/review.ts": reviewFactory,
}
```

If the resolver picks an extension path with no matching factory in the map, initialization fails outright — the teaching implementation does no dynamic TypeScript imports and doesn't silently skip missing modules. A trusted project's `.pi/extensions` reuses s12's entry discovery rules: top-level `.ts`/`.js` files are entries, subdirectories only count via `index.ts`/`index.js` or entries listed in a sub-manifest, and neighboring helper modules never enter the factory map.

## Try it yourself

The demo's provider is a single plain-text reply, so the tool part of the chain never fires. Edit `demo()` at the bottom of `code.ts`:

1. Swap the provider for s04's tool-calling provider:

   ```ts
   import { createToolLoopProvider } from "../s04_evented_tool_loop/code.ts";
   // ...
   provider: createToolLoopProvider({
     toolName: "read",
     args: { path: "README.md" },
     finalText: "Read the file through the integrated loop.",
   }),
   ```

   Rerun `npm run session:s13` and see what `Stored messages` becomes instead of 2. What is each extra message? Explain it from s07's point of view (hint: the assistant's toolCall, the tool result, and the final answer each land on disk as tagged JSON).

2. At the end of `demo()`, hand the same runtime to an s10 shell:

   ```ts
   import { runJsonMode } from "../s10_runtime_modes/code.ts";
   // ...
   console.log(await runJsonMode(runtime, "hello from the json shell"));
   ```

   After both prompts, check `runtime.getState().messageCount` — different shells are driving the same session state. That's s10's invariant, "a mode shell owns no agent state of its own", running on a real core.

3. The four end-to-end tests in `code.test.ts` are four ready-made modding recipes (the full package-skill chain, an extension blocking a tool, a trust rejection, four shells sharing one runtime). When you want to add ingredients, copy their fixtures into the demo.

When you're done, run `npm run test:s13` to confirm the chain still holds.

## Wiring into the main line

s13 is the main line closing on itself, so the usual diff table becomes a parts list:

| Part | From | Place in the chain |
| --- | --- | --- |
| Tool contract and registry | s02 | baseRegistry + merged extension tools |
| Provider event stream | s03 | wrapped by the adapter, consumed by s05 |
| Tool loop and event ordering | s04/s05 | `runHookedToolLoop()` executed as-is |
| Turn state snapshot | s06/s09 | rebuilt on every `prompt()` |
| Session tree | s07 | appends user/assistant/toolResult, supplies the next turn's branch |
| Resource loading | s08 | AGENTS.md/skills/templates enter the system prompt |
| Extension runtime | s09 | hooks, tools, custom messages join the turn |
| Runtime modes | s10 | four shells consume the same runtime |
| Trust | s11 | decides whether project inputs and extensions load |
| Package resolver | s12 | computes resource and extension paths |

## Against the Pi source

The source mapping lives in [pi-source.md](pi-source.md). Focus on how `agent-harness.ts` builds turn state, wires hooks, and stores messages, then on how coding-agent's `resource-loader.ts`, `agent-session.ts`, and the extension runner complete the product-layer orchestration — real Pi's "glue layer" is exactly those files.

Not implemented in this unit: context compaction, token budgets, a real provider, dynamic module imports, package install, terminal UI, hot reload, sandbox. `files`, the provider, tool handlers, and extension factories are all in-memory fixtures.

## Closing

Behind every choice across these thirteen units sits the same triple: what was chosen / what wasn't / what it costs. Collected once into a single table:

| Dimension | Pi's choice | The alternative not taken | The cost |
| --- | --- | --- | --- |
| Model access | a unified provider protocol | binding to a single SDK | one adapter layer per model vendor, and the protocol itself needs maintaining |
| Message structure | `AgentMessage` layered over LLM messages | sending the raw array directly | one more conversion, and debugging means knowing which layer you're in |
| Output surface | an event stream | returning a string synchronously | callers must consume a stream — no one-line `await` for the result |
| Session storage | an append-only session tree | an overwritable message array | history is immutable, branches need explicit management, storage only grows |
| Capability extension | extension / skill / package first | built-in plan mode / sub-agents | core features lean on the ecosystem; newcomers must learn the outer machinery first |
| Security boundary | trust separated from the execution environment | a built-in sandbox | you configure your own execution sandbox; trust only governs input loading |
| Capability distribution | packages as the distribution unit | hardcoding capabilities into core | the manifest/resolver layer is extra engineering — worth it once distribution exists |

That table is the through-line of this course: Pi core stays small, events stay legible, extension stays open, and isolation doesn't pretend to be solved inside the process. Whatever comes next — giving mini-pi a real provider, attaching a terminal UI, or reading the parts of the Pi source this course didn't cover — pick a row in the table and drill down.
