# s06 · Harness Turn State

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the `AgentMessage` boundary, `AgentHarness.createTurnState()`, and the conversion to model-facing `Message[]` in `pi-agent-core`.

```text
session AgentMessage[] -> TurnState snapshot -> transformContext -> convertToLlm -> model
                                      |
                                      +-> real tool loop -> persist every completed Message
```

## The problem

By s05, the loop can call a real model, execute `read_file`, and apply Tool Hooks. Its inputs are still scattered, though, and its history is limited to the messages the model understands.

A coding agent needs richer internal records: shell executions, extension messages, branch summaries, and compaction summaries. Sending those records directly to a provider would violate the provider's `Message` contract. Reading mutable configuration throughout a multi-step turn would create a different problem: the second provider call could use a different model, tool set, or prompt from the first.

## The idea

s06 introduces two boundaries:

```text
AgentMessage = pi-ai Message
             | BashExecutionMessage
             | CustomMessage
             | BranchSummaryMessage
             | CompactionSummaryMessage

TurnState = messages + resources + streamOptions + sessionId
          + systemPrompt + model + tools + activeTools
```

The session keeps `AgentMessage[]`. At the start of a turn, `createTurnState()` snapshots everything that turn will use. Only at the model boundary does `createLlmContext()` apply `transformContext` and then `convertToLlm()`.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s06
```

Or send one prompt directly:

```bash
npm run s06 -- "Use read_file to inspect package.json and report the pi-ai version."
```

This command runs the same real model-tool-model path as the earlier lessons. The wording and exact Tool Calls can vary; the stable behavior is that the prompt, Assistant Messages, and Tool Results are appended to the session as the turn proceeds.

## How the code works

### 1. Keep internal and model-facing messages separate

`AgentMessage` extends the official `pi-ai` `Message` union with four harness-only roles. `cloneAgentMessage()` deep-clones any member so session history and snapshots do not share mutable content.

This is not a second provider protocol. It is the harness's storage protocol.

### 2. Snapshot one turn

`createMiniHarness()` captures registered Tool definitions, selected active Tool names, Resources, Stream Options, and the System Prompt definition. `createTurnState()` then reads the current session Context and metadata, resolves a dynamic System Prompt, and returns independent copies:

```ts
const turnState = await createMiniHarness(options).createTurnState();

turnState.messages;
turnState.model;
turnState.tools;
turnState.activeTools;
turnState.resources;
turnState.streamOptions;
```

`tools` is the full registered set. `activeTools` is the subset exposed to the model and executable in this turn.

### 3. Convert only at the model boundary

`createLlmContext()` preserves the order of operations:

```ts
const transformed = transformContext
  ? await transformContext(agentMessages)
  : agentMessages;

const messages = convertToLlm(transformed);
```

Standard User, Assistant, and Tool Result Messages pass through. Bash, Custom, Branch Summary, and Compaction Summary records become model-readable User Messages; a Bash record marked `excludeFromContext` is omitted. The rich session values remain unchanged.

### 4. Run and persist the real turn

`runHarnessTurn()` creates the snapshot and model Context, selects the active Registry, appends the new User Message, and delegates to s05's `runHookedToolLoop()`. Its `message_end` listener awaits `session.appendMessage()` for every completed Assistant or Tool Result Message.

That ordering matters. If a later provider call fails after a tool has run, the earlier Assistant Message and Tool Result are already in the session. The harness does not wait until the whole turn succeeds before saving its history.

## Try it yourself

1. Add a `CustomMessage` to `createMemorySession()`, call `createLlmContext()`, and inspect how it becomes a User Message without changing the stored value.
2. Set `activeToolNames: []` and ask the model to read a file. Compare the model-facing Tool list with the full `turnState.tools` list.
3. Add a `transformContext` function that appends a context note. Confirm it reaches the model Context but is not automatically appended to the session.

## Wiring into the main line

| Boundary | s05 | s06 |
| --- | --- | --- |
| History type | model-facing `Message[]` | rich `AgentMessage[]` in the session |
| Turn inputs | separate Loop arguments | one `TurnState` snapshot |
| Model boundary | Messages already model-shaped | `transformContext` then `convertToLlm` |
| Tool exposure | Registry passed to the Loop | full Tools plus per-turn Active Tools |
| Persistence | returned after the Loop | each completed Message appended during the Loop |
| Provider path | real model and Tool Loop | the same real path through `runHarnessTurn()` |

## Against the Pi source

The `AgentMessage` roles, conversion order, and turn snapshot map to Pi 0.79.1. The course deep-clones more aggressively and leaves out fields such as `thinkingLevel`, queues, and provider-request Hooks.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## Next up

[s07 · Session Tree](../s07_session_tree/) replaces the in-memory Message list with append-only JSONL entries, branches, and summary entries that materialize back into `AgentMessage[]`.
