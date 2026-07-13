# s09 · Extension Runtime

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s08](../s08_context_resources/README.md) · [Contents](../README.md) · [s10 →](../s10_runtime_modes/README.md)

> In one sentence: when an extension loads, it registers tools, commands, and event handlers with the runner, and nothing gets called until an event fires — workflows plug in through registration, not by patching the core.
>
> Where this sits in Pi: `core/extensions` in `@earendil-works/pi-coding-agent` — the loader builds the `pi` object, the runner dispatches by event.

→ Pi's README states three Nos: no sub-agents, no plan mode, no built-in to-dos — not because they can't be built, but because Pi refuses to decide everyone's workflow for them
→ Every feature turned away from the core lives on as an extension: todo.ts and subagent/ under `examples/extensions/` are the physical evidence
→ Registration ≠ execution: when the factory finishes, all that's left is a record; only when events fire does the runner call handlers, in load order
→ Extensions can also inject custom messages before the agent starts — Pi has more internal message kinds than the model knows about, and that layering pays off here for the first time

---

## The problem

By s08, the core has everything it should: tool schemas, an event stream, a tool loop with hooks, turn state, a session tree, context resources. The natural next impulse is to keep stuffing features in — other coding agents have plan mode, sub-agents, a todo panel. Shouldn't Pi build those in too?

First look at what users actually want:

```text
someone wants to block dangerous bash commands
someone wants to add an internal tool for the model
someone wants project rules appended before every request
someone wants todos: register a todo tool whose state follows session branches
someone wants sub-agents: spawn independent pi child processes — scout, planner, reviewer, each doing its own thing
```

The first three are small — intercept something here, add something there. The last two are full workflows, and that's where the trouble is: should sub-agents run in parallel or in series, how is context isolated, how do results come back? Do todos live in a file or follow session branches? Are plans written for humans or for the model? None of these questions has an answer that fits everyone. Bake it into the core and you're deciding for everyone — and it's hard to rip out if you got it wrong.

Pi's answer is written right in the Philosophy section of its README ([`packages/coding-agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/README.md)):

> **No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way.
>
> **No plan mode.** Write plans to files, or build it with extensions, or install a package.
>
> **No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with extensions.

The three Nos don't cut features — they relocate them. All of these workflows can be built, but at the extension layer, so the disagreement shifts from "the core chooses for you" to "you choose." And it's not just talk: `examples/extensions/todo.ts` registers a todo tool plus a `/todos` command, stores state in session entries so todos follow branches; `examples/extensions/subagent/` uses a single tool to spawn independent pi child processes, complete with a full set of agent definitions and an `/implement` workflow. Every feature turned away from the core lives on as an extension, without a single line of core code changing.

So this unit's question is: what kind of opening does the core need so that both small things like blocking a command and big workflows like sub-agents can plug in from outside.

## The idea

An extension is a file whose default export is a factory. At load time the factory receives a `pi` object and registers capabilities on it; the runner files the registrations away and only calls them when events fire:

| Registration point | What it registers | When it gets called |
| --- | --- | --- |
| `pi.registerTool` | a new tool for the model | when the model issues a toolCall |
| `pi.registerCommand` | a user slash command | when the user types `/name` |
| `pi.on("tool_call")` | a check before tool execution | before every tool run |
| `pi.on("before_agent_start")` | edit the system prompt, inject custom messages | before the agent starts |
| `pi.on("resources_discover")` | dynamically add skill / prompt paths | at startup and on reload |

One line runs through the whole mechanism: registration ≠ execution. While the factory runs, no tool executes and no request goes out — it just writes handlers, tools, and commands into an extension record. The todo and sub-agent stories above are all combinations of these few registration points.

This unit skips UI components, keyboard shortcuts, renderers, and provider registration — capabilities the real runtime also has — and keeps three main lines: register capabilities, dispatch by event, wire results back into the existing turn state.

## Run it first

```sh
npm run session:s09
```

The output looks like this:

```text
Tools: read, bash, note
Command notification: hello Pi
System prompt has extension note: true
Blocked bash: Dangerous shell command
```

Four lines, four facts: the extension-registered `note` tool made it into the tool table; the `/hello` command went through; `before_agent_start` appended a line to the system prompt; `tool_call` blocked a bash command containing `rm -rf`.

## How the code works

### The factory leaves nothing behind but a record

In real Pi, an extension file default-exports a function:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(/* ... */);
  pi.registerCommand(/* ... */);
  pi.on("tool_call", /* ... */);
}
```

The mini uses the same shape:

```ts
export type MiniExtensionFactory = (pi: MiniExtensionAPI) => void | Promise<void>;
```

The `pi` object the factory receives does exactly one thing — record keeping:

```ts
function createExtensionApi(extension: LoadedExtension): MiniExtensionAPI {
  return {
    on(event, handler) {
      extension.handlers[event].push(handler as never);
    },
    registerTool(tool) {
      extension.tools.push(cloneTool(tool));
    },
    registerCommand(name, command) {
      extension.commands.push({ name, ...command });
    },
  };
}
```

All three methods push into the extension record. When the factory finishes, no handler has been called and no tool has run. So when does anything execute? Look at the runner's three emits.

### before_agent_start runs as a chain

```ts
async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<{
  systemPrompt: string;
  messages: MiniCustomMessage[];
}> {
  let currentSystemPrompt = event.systemPrompt;
  const messages: MiniCustomMessage[] = [];

  for (const extension of this.extensions) {
    for (const handler of extension.handlers.before_agent_start) {
      const ui = createMiniUi();
      const result = await handler(
        { ...event, systemPrompt: currentSystemPrompt },
        createContext(ui, currentSystemPrompt),
      );

      if (result?.message) {
        messages.push({ ...result.message });
      }
      if (result?.systemPrompt !== undefined) {
        currentSystemPrompt = result.systemPrompt;
      }
    }
  }

  return {
    systemPrompt: currentSystemPrompt,
    messages,
  };
}
```

The runner walks extensions in load order. When one handler changes the system prompt, the next handler sees the changed version in its event — in the test, two extensions append `[first]` and `[second]` in turn, ending with `base\n[first]\n[second]`. Extensions are outer-layer workflows; when several are present at once, the runner has to give them a stable execution order, or which one overwrites which comes down to luck.

### Extensions can also slip in a custom message

There's another `messages.push` in the code above, fed by a second field on the handler's return value:

```ts
export type BeforeAgentStartResult = {
  systemPrompt?: string;
  message?: MiniCustomMessage;
};
```

```ts
export type MiniCustomMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
```

This is the extension's opening to inject messages into the current run before the agent starts. s06 covered how Pi's internal message kinds outnumber what the model knows about — AgentMessage and LLM message are separate layers, and custom messages live in that gap: they carry their own `customType` and arbitrary `details`, `display` decides whether the user sees them, and whether they enter the model context is up to the conversion layer. A plan-mode extension can inject the current plan into the run here; a stats extension can push a notice only the UI sees. The mini keeps the collected messages in `ExtensionTurnState.beforeAgentStartMessages`.

### tool_call is the gate before execution

```ts
async emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
  for (const extension of this.extensions) {
    for (const handler of extension.handlers.tool_call) {
      const result = await handler(event, createContext(createMiniUi(), ""));
      if (result?.block) {
        return { block: true, reason: result.reason };
      }
    }
  }

  return undefined;
}
```

Before each tool executes, the runner polls the extensions: whoever returns `{ block: true }` blocks it; if nobody does, the runner returns `undefined` and the tool runs. The demo blocks bash containing `rm -rf`. This is also what lets Pi skip a built-in permission popup — the confirmation flow is itself a workflow. You can block all bash, or only writes to `.env`; everyone writes their own extension.

### resources_discover hands resource paths to s08

In s08, skill and prompt paths were hard-coded by the caller. s09 opens another source. The heart of `emitResourcesDiscover()` is this:

```ts
for (const extension of this.extensions) {
  for (const handler of extension.handlers.resources_discover) {
    const result = await handler({ cwd, reason }, createContext(createMiniUi(), ""));
    for (const path of result?.skillPaths ?? []) {
      discovered.skillPaths.push({ path, extensionPath: extension.path });
    }
    for (const path of result?.promptPaths ?? []) {
      discovered.promptPaths.push({ path, extensionPath: extension.path });
    }
    for (const path of result?.themePaths ?? []) {
      discovered.themePaths.push({ path, extensionPath: extension.path });
    }
  }
}
```

Every path is tagged with `extensionPath` — a note of which extension reported this resource. Real Pi carries that origin on to the resource loader, for diagnostics, display, and conflict handling.

### Everything wires back into turn state

```ts
export async function createExtensionTurnState(
  options: Omit<CreateContextResourceTurnStateOptions, "registry"> & {
    runner: MiniExtensionRunner;
    registry: ToolRegistry;
    prompt?: string;
  },
): Promise<ExtensionTurnState> {
  const discovered = await options.runner.emitResourcesDiscover(options.cwd, "startup");
  const registry = mergeExtensionTools(options.registry, options.runner);
  const turnState = await createContextResourceTurnState({
    ...options,
    registry,
    skillFiles: [...(options.skillFiles ?? []), ...discovered.skillPaths.map((entry) => entry.path)],
    promptTemplateFiles: [...(options.promptTemplateFiles ?? []), ...discovered.promptPaths.map((entry) => entry.path)],
  });
  const beforeAgentStart = await options.runner.emitBeforeAgentStart({
    prompt: options.prompt ?? "",
    systemPrompt: turnState.systemPrompt,
    systemPromptOptions: { cwd: options.cwd },
  });

  return {
    ...turnState,
    systemPrompt: beforeAgentStart.systemPrompt,
    beforeAgentStartMessages: beforeAgentStart.messages,
  };
}
```

The order matters: fire `resources_discover` first, because extension-reported paths have to be merged into `skillFiles` and `promptTemplateFiles` before s08 loads resources; then merge extension tools into the s02 registry; then let s08 build the turn state; finally `before_agent_start` gets the last edit on the assembled system prompt, and the custom messages get collected along the way.

Extensions replace nothing that already exists: blocking bash, adding tools, slash commands, extra rules, a whole todo system — all of it goes through these registration points instead of patching the core. The s02 registry, the s06 snapshots, the s08 resource pipeline are all still there; each link just grew a socket.

## Try it yourself

The demos all live in `runDemo()`; rerun `npm run session:s09` after each change:

1. Write a mini-todo extension by hand and feel for yourself that workflows don't need to enter the core. Add an entry to the array in `loadMiniExtensions`:

   ```ts
   {
     path: "todo.ts",
     factory(pi) {
       const todos: string[] = [];
       pi.registerTool({
         name: "todo",
         label: "todo",
         description: "Add a todo and list all todos.",
         parameters: {
           type: "object",
           properties: { text: { type: "string" } },
           required: ["text"],
         },
         handler(input) {
           todos.push(String(input.text));
           return { toolName: "todo", content: todos.map((text, i) => `${i + 1}. ${text}`).join("\n") };
         },
       });
     },
   },
   ```

   After a rerun, the first line becomes `Tools: read, bash, note, todo`. That's the skeleton of Pi's `examples/extensions/todo.ts` — the real one stores state in session entries so todos follow session branches, but it likewise never touches a line of core code.

2. Build a gate that blocks `note`: register another `tool_call` handler in the demo's extension that returns `{ block: true, reason: "notes are frozen" }` when `event.toolName === "note"`, then add a `console.log` at the end of the demo that prints the result of `await runner.emitToolCall({ toolName: "note", input: { text: "x" } })`. Also change `emitToolCall`'s bash command from `rm -rf tmp` to `ls` and watch it return `undefined` — nobody blocks, so it passes.

When you're done, `npm run test:s09` confirms you haven't broken this unit's behavioral contract.

## Wiring into the main line

s09 fits a socket onto every link of the main line:

| Component | Previous unit (s08) | This unit (s09) |
| --- | --- | --- |
| Tool registry | hard-coded at app startup | base registry merged with extension-registered tools |
| skill / prompt paths | given explicitly as caller arguments | on top of arguments, `resources_discover` can add them dynamically |
| system prompt | final once context files + activeTools are assembled | after assembly, `before_agent_start` still gets the last edit |
| before tool execution | s05 hooks hard-coded in app code | the `tool_call` event is open to any extension |
| turn state | `ContextResourceTurnState` | `ExtensionTurnState`, adding `beforeAgentStartMessages` |

## Against the Pi source

Read [pi-source.md](pi-source.md) after this unit.

The mapping in one sentence: `loadMiniExtensions()` corresponds to `createExtensionAPI()` in `loader.ts` — there you can see the same thing, that `pi.on`, `pi.registerTool`, and `pi.registerCommand` do nothing but write into an extension record; the three emits on `MiniExtensionRunner` correspond to `emitBeforeAgentStart()`, `emitResourcesDiscover()`, and `emitToolCall()` in `runner.ts`. The real runtime also carries a whole layer of UI components, shortcuts, renderers, and provider registration — none of which this unit builds. Anchors and the simplification list are in pi-source.

## Next up

The core has an extension opening now, but so far there's exactly one way to use it: call functions directly from code. The real Pi needs to run interactively in a terminal, print JSON in CI, serve other programs over RPC, and embed as an SDK — and these are not four agents.

[s10 Runtime Modes](../s10_runtime_modes/README.md): the same core and extension runtime, plugged into four shells — interactive, print/json, rpc, sdk.
