# Pi Source Map for s06

s06 corresponds to `AgentHarness.createTurnState()`.

```text
session + resources + tools + model + stream options
  -> turn state
  -> createContext()
  -> runAgentLoop()
```

## Files

- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)

Specific anchors:

```text
agent-harness.ts:158-172  AgentHarnessTurnState
agent-harness.ts:200-222  constructor stores tools/resources/options
agent-harness.ts:331-362  createTurnState()
agent-harness.ts:365-373  createContext()
agent-harness.ts:377-404  createStreamFn() uses streamOptions/sessionId
harness/types.ts:46-78    Skill / PromptTemplate / AgentHarnessResources
harness/types.ts:80-96    AgentHarnessStreamOptions
harness/types.ts:798-831  AgentHarnessOptions
```

## Mapping

| s06 | Pi |
| --- | --- |
| `MiniHarness.createTurnState()` | `AgentHarness.createTurnState()` |
| `MiniSession.buildContext()` | `Session.buildContext()` |
| `MiniSession.getMetadata()` | `Session.getMetadata()` |
| `resources` | `AgentHarnessResources` |
| `streamOptions` | `AgentHarnessStreamOptions` |
| `systemPrompt` function | `AgentHarnessOptions.systemPrompt` callback |
| `activeToolNames` | `AgentHarness.activeToolNames` |
| `activeTools` | the tools handed to the model this turn |

## What s06 doesn't do yet

s06 does not implement any of this:

```text
real Session storage
JSONL entry tree
compaction
resources discovery / reload
before_agent_start hook
before_provider_request hook
provider payload patch
auth headers merge
```

Each of these gets its own section later. s06 answers one question only: before a turn starts, what does Pi snapshot?

## Suggested reading path

Start with lines 331-362 of [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts). That's `createTurnState()`.

Then lines 365-373. `createContext()` pulls the three things the provider actually needs out of the turn state: systemPrompt, messages, activeTools.

Finish with `AgentHarnessOptions` in `harness/types.ts`. It shows where each of these fields is passed in from.
