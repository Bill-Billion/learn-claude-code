# s06 against the Pi 0.79.1 source

s06 joins Pi's `AgentMessage` boundary to the Harness turn snapshot.

```text
Session.buildContext()
  -> AgentHarnessTurnState
  -> transformContext(AgentMessage[])
  -> convertToLlm(Message[])
  -> provider
```

## Corresponding files

- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/messages.ts)

## The mapping

| s06 | Pi 0.79.1 |
| --- | --- |
| `AgentMessage` | core `AgentMessage` plus coding-agent custom-message augmentation |
| four harness-only Message roles | `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage` |
| `convertToLlm()` | coding-agent `convertToLlm()` |
| `TransformContext` | `AgentLoopConfig.transformContext` |
| `createMiniHarness().createTurnState()` | `AgentHarness.createTurnState()` |
| `TurnState.activeTools` | the active Tools copied into `AgentContext.tools` |
| `runHarnessTurn()` | Harness state feeding the core Agent Loop |

Pi's `streamAssistantResponse()` applies `transformContext` to `AgentMessage[]` first, calls `convertToLlm()` second, and only then builds the provider `Context`. The course preserves that boundary.

## Message conversion

Pi's coding-agent `messages.ts` defines the same four extra roles reconstructed by the lesson. Standard User, Assistant, and Tool Result Messages pass through. Bash and Custom records become User Messages, and Branch or Compaction Summaries become prefixed User Messages.

The course keeps the same semantic split but uses shorter summary wrappers. It also deep-clones converted values so the teaching snapshot is easy to test.

## Turn snapshot and persistence

Pi's `AgentHarnessTurnState` contains Messages, Resources, Stream Options, Session ID, System Prompt, Model, Tools, Active Tools, and `thinkingLevel`. s06 omits only `thinkingLevel` from that snapshot shape.

`runHarnessTurn()` is course composition rather than a copied Pi function. It connects the snapshot to the s05 Loop and persists each `message_end` value through the Session sink. The important shared ownership rule is that the Harness prepares state while the Agent Loop owns model and Tool progression.

## Course scope

s06 intentionally leaves out steering and follow-up queues, abort handling, provider-request Hooks, API-key refresh, retry policy, and automatic compaction. It does not replace the Provider with a scripted response: the lesson CLI still loads a real `pi-ai` Model and can continue through `read_file` Tool Results.

## Suggested reading order

1. Read the custom Message declarations and `convertToLlm()` in coding-agent `messages.ts`.
2. Read `streamAssistantResponse()` in `agent-loop.ts` for the transformation order.
3. Read `AgentHarnessTurnState`, `createTurnState()`, and `createContext()` in `agent-harness.ts`.
4. Compare those boundaries with `AgentMessage`, `createLlmContext()`, and `runHarnessTurn()` in this lesson.
