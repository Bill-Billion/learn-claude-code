# s10 · Runtime Modes

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s09](../s09_extension_runtime/README.md) · [Contents](../README.md) · [s11 →](../s11_trust_execution_env/README.md)

> In one sentence: runtime modes aren't separate agents — they're different I/O shells around one core, and a shell depends on exactly two methods: `prompt()` and `getState()`.
>
> Where this sits in Pi: the mode dispatch in `main.ts` of `@earendil-works/pi-coding-agent`, plus the `modes/` shell layer.

→ Pi has exactly four runtime modes: interactive, print, rpc, sdk — json isn't a fifth, it's another output branch of print mode
→ The five shell functions total under a hundred lines — not corner-cutting, but because the interface walls state and history off on the core side, leaving the shells nothing to write but I/O
→ This unit's core is deliberately an echo stub that imports nothing from the previous nine units — the invariant on display depends only on the interface, not on the core's insides
→ Swapping the core requires no shell changes: hand-write an object that merely satisfies the interface and all five shells just run; s13 uses exactly this contract to plug the real core back in

---

## The problem

After s09, mini Pi has tools, an event stream, hooks, turn state, a session tree, context resources, and an extension runtime. But so far only tests and demos call this pile of machinery directly — it has no entry point in the product sense.

Faced with entry points, the instinctive plan is one setup per use case: a loop for terminal interaction, a one-shot function for script calls, another command service for process integration, each maintaining its own message history. Four entries, four copies of state — and soon you get cracks like "what I asked over RPC is invisible in interactive."

Pi doesn't do that. `main.ts` creates the `AgentSessionRuntime` first, and only then decides which mode gets it: interactive handles terminal interaction, print grabs the final text (`--mode json` switches to emitting the event stream), RPC turns actions like prompt and get_state into a JSONL command protocol, and SDK hands external programs the `AgentSession` directly. The runtime is built once; the shells are just different ways in and out.

## The idea

Compress the entry problem to its minimum: the core implements a two-method interface, and the shells depend only on that interface.

```ts
export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
}
```

Five shells, each owning one style of in and out:

| Shell | Who it's for | In / out |
| --- | --- | --- |
| `runInteractiveMode()` | a human at a terminal | terminal input / conversation transcript |
| `runPrintMode()` | one-shot Q&A from scripts | one prompt / final text |
| `runJsonMode()` | pipes and logs | one prompt / JSONL event stream |
| `runRpcMode()` | other processes | JSONL commands / JSONL responses |
| `createSdkSession()` | Node/TS programs | method calls / return values + event subscription |

Count them: five shells, yet Pi's official line is four modes. No contradiction — in Pi, print and json both belong to print-mode, two output branches of one mode (text takes the last answer, json emits events line by line). This unit splits them into two functions because their difference sits entirely in the output layer, and splitting makes that easier to see.

One more thing to say out loud up front: this unit's `MiniCoreRuntime` is a deliberately hollow echo stub. It imports nothing from the previous nine units; `prompt()` just formats the input into `mini pi: <input>`. That's not laziness — the invariant this unit demonstrates is that mode shells own no agent state of their own, and that invariant depends only on the `prompt()`/`getState()` interface, not on whether the core behind it is an echo or a real agent loop. In s13, `IntegratedHarnessRuntime` implements the same `MiniRuntime` interface and plugs the real core built across s01–s09 into these very shells — that's where "get the boundary right and the shells become swappable" actually gets cashed in.

## Run it first

```sh
npm run session:s10
```

The output looks like this:

```text
Print: mini pi: hello print
JSON event types: session, agent_start, message, agent_end
RPC turns: 2
```

Three lines from one `MiniCoreRuntime`: print ran a turn, json ran another, and finally RPC's `get_state` queried the same runtime — which is why `turns` is 2, instead of each shell counting from zero.

## How the code works

### State lives only in the core

`MiniCoreRuntime.prompt()` is the only place in this unit that mutates state:

```ts
async prompt(prompt: string): Promise<MiniRunResult> {
  const runId = `${this.sessionId}:${this.runs.length + 1}`;
  const finalText = `${this.answerPrefix}: ${prompt}`;
  const userMessage: MiniRuntimeMessage = { role: "user", content: prompt };
  const assistantMessage: MiniRuntimeMessage = { role: "assistant", content: finalText };

  this.messages.push(userMessage, assistantMessage);

  const events: MiniRuntimeEvent[] = [
    { type: "session", sessionId: this.sessionId, runId },
    { type: "agent_start", sessionId: this.sessionId, runId, prompt },
    { type: "message", sessionId: this.sessionId, runId, role: "assistant", content: finalText },
    { type: "agent_end", sessionId: this.sessionId, runId, finalText },
  ];
  const result: MiniRunResult = {
    sessionId: this.sessionId,
    runId,
    finalText,
    events: cloneEvents(events),
    messages: this.getMessages(),
  };

  this.runs.push({ ...result, prompt });
  return cloneRunResult(result);
}
```

Each turn mints a `runId`, appends two messages, produces one batch of events, then clones both events and messages before handing them over — shells get snapshots and can't reach into the core. A mode gets to decide how to display, how to accept commands, how to serialize, but it doesn't get to maintain its own conversation history. In real Pi this corresponds to `AgentSession.prompt()`, and the `AgentSessionRuntime` that holds it also handles session switching, fork, and resume.

### print only wants the last line

```ts
export async function runPrintMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return result.finalText;
}
```

For a one-shot question from a script: no event subscription, no state kept — take `finalText` and leave. Real Pi's text branch has the same disposition — call `session.prompt()`, pull the last assistant text from session state, write it to stdout.

### json dumps the event stream as-is

```ts
export async function runJsonMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}
```

json invents no new return shape: it serializes the core's events into JSONL line by line, and downstream decides whether to filter for `agent_end` or `message`. Compare it with print above: the two functions differ only in the return line — this is "print and json are two output branches of the same mode," as it lands in code.

### rpc turns actions into commands

```ts
switch (command.type) {
  case "prompt":
    return {
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: await runtime.prompt(command.message),
    };
```

The `get_state` branch has the same shape, with `data` swapped for `runtime.getState()`; unknown commands return `success: false` (see code.ts for the full switch). rpc targets process integration: an external program doesn't parse a TUI, and one-shot text isn't enough for it — it sends commands carrying an `id` and matches responses by that `id`. To keep this a readable single file, the prompt command here returns the full `MiniRunResult` synchronously; in real Pi's RPC, the prompt response only means the request was accepted, content keeps flowing out of the event stream, and the command table is much longer — steer, follow_up, abort, fork, set_model, and so on.

### sdk is the thinnest layer: you get the object directly

```ts
const listeners = new Set<(event: MiniRuntimeEvent) => void>();

return {
  async prompt(prompt: string): Promise<MiniRunResult> {
    const result = await runtime.prompt(prompt);
    for (const event of result.events) {
      for (const listener of listeners) {
        listener({ ...event });
      }
    }
    return result;
  },
  getState(): MiniRuntimeState {
    return runtime.getState();
  },
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

sdk has no inter-process protocol: the host program creates a session, subscribes to events, and calls `prompt()` directly. When you're building your own UI, sdk is usually more comfortable than rpc. Real Pi's `createAgentSession()` also accepts options like model, tools, resourceLoader, sessionManager.

### interactive just glues the terminal on

```ts
export async function runInteractiveMode(runtime: MiniRuntime, prompts: string[]): Promise<string[]> {
  const transcript: string[] = [];

  for (const prompt of prompts) {
    transcript.push(`user> ${prompt}`);
    const result = await runtime.prompt(prompt);
    transcript.push(`assistant> ${result.finalText}`);
  }

  return transcript;
}
```

This unit builds no TUI — it just returns a transcript — which actually makes interactive's position easier to see: feed input to the core, put output back on the terminal, nothing more. Real Pi's interactive mode has an editor, a footer, a tree selector, keyboard shortcuts — those UI layers can stack up precisely because the session/runtime boundary underneath held still first.

### Swap the core, and the shells keep running

code.test.ts has five tests. The first four each watch one shell; the fifth is the strongest test of this unit's whole philosophy: hand-write an object that only satisfies the `MiniRuntime` interface — no inheritance, no use of `MiniCoreRuntime` — feed it to every shell, and everything works as usual.

```text
print, json, rpc, and sdk drive the same core; getState()'s turns/messageCount line up
json mode emits events line by line in session, agent_start, message, agent_end order
after an rpc prompt, get_state sees the same state
the interactive transcript is just a terminal wrapper around prompt()
every shell accepts a hand-written minimal MiniRuntime object; none requires MiniCoreRuntime
```

The fifth one isn't testing a feature — it tests the contract between shells and core itself. s13 can plug the real core back in because of that contract.

## Try it yourself

Play s13 for a minute: write a new `MiniRuntime` implementation and feed it to the shells. In `demo()` in code.ts, add an uppercase echo runtime:

```ts
const shout: MiniRuntime = {
  async prompt(prompt) {
    const finalText = prompt.toUpperCase();
    return {
      sessionId: "shout",
      runId: "shout:1",
      finalText,
      events: [{ type: "agent_end", sessionId: "shout", runId: "shout:1", finalText }],
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: finalText },
      ],
    };
  },
  getState() {
    return { sessionId: "shout", turns: 1, messageCount: 2 };
  },
};
console.log(await runPrintMode(shout, "hello shout"));
```

Rerun `npm run session:s10` and an extra line `HELLO SHOUT` appears. Then feed `shout` to `runJsonMode`, `runRpcMode`, and `runInteractiveMode` in turn — not a single shell line changes, and they all take it. What you just verified by hand is the contract the fifth test guards: shells recognize only the interface.

Second experiment (if your machine has jq): replace the `console.log` that prints JSON in `demo()` with `process.stdout.write(jsonText);`, comment out the other `console.log`s for now, then:

```sh
node s10_runtime_modes/code.ts --demo | jq -r 'select(.type == "message") | .content'
```

The JSONL payoff shows up on the spot: the core did nothing for jq — the event stream itself is a machine-readable interface.

Put things back when you're done, and run `npm run test:s10` to confirm the shells' behavioral contract is intact.

## Wiring into the main line

| Component | Previous unit (s09) | This unit |
| --- | --- | --- |
| Entry point | no entry layer; tests and demos call functions directly | five shells — interactive / print / json / rpc / sdk — each owning one I/O style |
| Core's exposed surface | a pile of internal objects: runner, registry, turn state | collapsed to two methods: `prompt()` + `getState()` |
| Event stream | consumed in-process by extension handlers | json serializes to JSONL, sdk opens subscribe — consumers outside the process start to appear |
| Session state | scattered across each unit's mechanisms | lives only in the runtime; shells are uniformly stateless |

s13's `IntegratedHarnessRuntime` reuses this row of shells as-is — at that point the only row in the diff table that changes is the core.

## Against the Pi source

Read [pi-source.md](pi-source.md) after this unit. The real entry is `main.ts`: `resolveAppMode()` decides the mode, `AgentSessionRuntime` is built exactly once, then dispatched to `runRpcMode()`, `InteractiveMode`, or `runPrintMode()`. This unit's `runPrintMode()`/`runJsonMode()` correspond to the text/json branches inside `modes/print-mode.ts` — which is also where "json is an output branch of print mode" comes from. One more caveat: this unit's event vocabulary (session / agent_start / message / agent_end) is the mini's own invention — it's neither s04's nor Pi's; the differences are detailed in pi-source.md.

## Next up

Once one core can wear five shells, there's a question no shell can answer: a cloned repo has `.pi/settings.json` and `.pi/extensions/` sitting in it — should the runtime load them at startup? And after loading is declined, what can the tools still do? Mode will make one more appearance in this story — non-interactive shells can't pop a confirmation dialog.

[s11 Trust And Execution Env](../s11_trust_execution_env/README.md): trust governs input loading; the execution boundary is a separate matter.
