# s02 · Tool Schema

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s01](../s01_agent_loop/README.md) · [Contents](../README.md) · [s03 →](../s03_provider_events/README.md)

> In one sentence: a tool is a contract the model reads first, and locally executable code second — the two sides are joined at registration and split apart before anything goes to the provider.
>
> Where this sits in Pi: the boundary between the `Tool` contract in `@earendil-works/pi-ai` and the agent-side `AgentTool` runtime object.

→ `ToolDefinition` has exactly three fields — name / description / parameters — and that's everything the model gets to see
→ label and handler both live on the `RegisteredTool` side: one is a UI display field, the other a local function, and the provider gets neither
→ The stripping happens in one function, `listToolDefinitions()` — the registry is a local runtime asset; the provider payload can only be a serializable contract
→ `dispatchTool()` is just a table lookup plus required-field checks; between the model asking for a tool and the tool actually running sits all of s04

---

## The problem

In the s01 demo the assistant already announced it wanted to call a tool, but the system had no such thing as a "tool" — the model didn't know what tools were available, and there was no local function that could be called.

The easiest mistake when adding tools is to start with the tool loop: the reader gets hit with schemas, handlers, toolCalls, toolResults, error handling, and event streams all at once. That's not how Pi mixes these concepts. In Pi, a tool splits into two sides first:

```text
The side the model sees: name / description / parameters
The side local code uses: execute or handler
```

The model only needs to know what the tool does and what its parameters look like. It can't get the local function, and it shouldn't know how the tool reads files or runs shell commands internally. s02 covers this boundary and nothing else.

## The idea

Pin the two sides down with two types, then land the boundary in one function:

| Field | Lives in | Visible to the model? |
|------|--------|-------------|
| `name` / `description` / `parameters` | `ToolDefinition` | Yes — this is the contract itself |
| `label` | `RegisteredTool` | No — UI display only |
| `handler` | `RegisteredTool` | No — local function |

At registration the two sides live together (`RegisteredTool = ToolDefinition & { label, handler }`); before anything goes to the provider, `listToolDefinitions()` strips label and handler off in one move.

This lesson executes no tools. `dispatchTool()` only demonstrates the other half of the boundary: local code can find the handler back by name.

## Run it first

```sh
npm run session:s02
```

Output:

```text
Tools visible to the provider:
- read: Read a file by path. The s02 demo does not touch the filesystem.
- bash: Describe a shell command. The s02 demo does not execute it.
Dispatch result: read: README.md
```

The `read` here reads no file, and the `bash` opens no shell. They exist to prove two things: the provider can see the tool schemas, and local code can find a handler by tool name.

## How the code works

Four steps.

**Step 1**: write the two sides as two types. `ToolDefinition` is the model-visible contract:

```ts
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
};
```

`RegisteredTool` stacks two local fields on top of the contract:

```ts
export type RegisteredTool = ToolDefinition & {
  label: string;
  handler: ToolHandler;
};
```

`label` is the display name for the terminal UI. Pi's `AgentTool` carries it too, and provider serialization never sends it — it belongs to the same side as the handler and only means something locally. As for the parameter schema, Pi's real code uses TypeBox, because the schema has to serialize, adapt to different providers, and validate at runtime; the teaching version starts with a tiny subset of JSON schema.

**Step 2**: registration. `createToolRegistry()` checks for duplicate names before accepting the tool array:

```ts
export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const seen = new Set<string>();

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    seen.add(tool.name);
  }

  return { tools };
}
```

Every later lookup is keyed by name — when the model makes a call, all it reports is the name. If two tools share a name, dispatch turns into a coin flip, so registration throws right away and catches the problem at the earliest possible point.

**Step 3**: stripping. Before anything goes to the provider, `listToolDefinitions()` lets only the contract through:

```ts
export function listToolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.tools.map(({ handler: _handler, label: _label, ...definition }) => ({
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: { ...definition.parameters.properties },
      required: definition.parameters.required ? [...definition.parameters.required] : undefined,
    },
  }));
}
```

The destructuring drops handler and label together, and what's left is exactly the three fields of `ToolDefinition`; `parameters` gets copied one level deeper, so the return value and the registry can't affect each other. The model only ever sees this serializable contract, and the local function stays on the runtime side for good. This is the first boundary in Pi's tool system — s04's execution and s05's hooks are both built on top of it.

**Step 4**: local code finds the handler back by name.

```ts
export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  validateInput(tool, input);
  return tool.handler(input);
}
```

The `validateInput()` in the middle is minimal validation: it only checks that the fields listed in `parameters.required` are present in the input, and throws if one is missing. Pi uses TypeBox for full type validation; here we just make one thing true — the schema isn't just documentation, it can actually block bad input:

```ts
function validateInput(tool: ToolDefinition, input: Record<string, unknown>): void {
  for (const key of tool.parameters.required ?? []) {
    if (!(key in input)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
  }
}
```

dispatch is just a name lookup for the handler — it's not Pi's tool loop yet. The real Pi emits `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` around tool execution, and also runs `beforeToolCall` and `afterToolCall`.

## Try it yourself

1. Add a `console.log(JSON.stringify(registry.tools[0]))` inside `runDemo()` and compare it with the contents of `definitions`. You'll see the handler vanish silently (functions never survive JSON anyway) while the label leaks through untouched — which is exactly why you can't count on serialization to do the stripping for you; the boundary has to be written out explicitly.
2. Add a third tool `write` to `createDemoToolRegistry()` with two required parameters, `path` and `content`. Run `npm run session:s02` and confirm it shows up in the "Tools visible to the provider" list; then deliberately leave out `content` when calling `dispatchTool`, and watch `validateInput` throw `Missing required parameter: content`.
3. Rename `bash` to `read` as well and run the demo: `createToolRegistry()` throws `Duplicate tool: read` before any tool gets used.

When you're done, run `npm run test:s02` to confirm you haven't broken this lesson's behavior contract.

## Wiring into the main line

| Component | Previous lesson | This lesson |
| --- | --- | --- |
| Tool contract | None — the assistant said it wanted a tool, but the system had no concept of one | `ToolDefinition`: name / description / parameters |
| Local executable side | None | `RegisteredTool` carries label and handler; `dispatchTool()` calls by name |
| Model/local boundary | Not needed — the provider only received messages | `listToolDefinitions()` strips handler and label, letting only the serializable contract through |

s03's `ProviderContext.tools` holds exactly this contract list, and s04's tool loop then uses `dispatchTool()` to route the model's toolCall back into local execution.

## Against the Pi source

Read [pi-source.md](pi-source.md) after finishing this lesson.

The mapping in one sentence: `ToolDefinition` corresponds to pi-ai's `Tool`, and `RegisteredTool` to the agent package's `AgentTool` — in Pi, label and `execute()` also live on the runtime side; the step that actually keeps only name / description / parameters is the provider-side serialization, e.g. `convertTools()` in the anthropic provider. Note that coding-agent also has a type named `ToolDefinition`, which is not the same thing as s02's — pi-source has the disambiguation.

## Next up

The model can now see the tool contracts, but s01's `provider.complete()` still returns the whole assistant message in one shot. A real model generates token by token — text and tool-call arguments both come out in fragments.

[s03 Provider Events](../s03_provider_events/README.md): Pi breaks "the model is generating" into a stream of events — the assistant can emit a toolCall inside the stream, but the local handler still never runs; execution happens in s04.
