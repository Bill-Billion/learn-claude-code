# s06 的 Pi 源码对照

s06 对应 `AgentHarness.createTurnState()`。

```text
session + resources + tools + model + stream options
  -> turn state
  -> createContext()
  -> runAgentLoop()
```

## 对应文件

- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)

具体锚点：

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

## 对应关系

| s06 | Pi |
| --- | --- |
| `MiniHarness.createTurnState()` | `AgentHarness.createTurnState()` |
| `MiniSession.buildContext()` | `Session.buildContext()` |
| `MiniSession.getMetadata()` | `Session.getMetadata()` |
| `resources` | `AgentHarnessResources` |
| `streamOptions` | `AgentHarnessStreamOptions` |
| `systemPrompt` function | `AgentHarnessOptions.systemPrompt` callback |
| `activeToolNames` | `AgentHarness.activeToolNames` |
| `activeTools` | 本轮传给 model 的 tools |

## 本节暂时不做什么

s06 没有实现这些内容：

```text
真实 Session storage
JSONL entry tree
compaction
resources discovery / reload
before_agent_start hook
before_provider_request hook
provider payload patch
auth headers merge
```

这些后面分开讲。s06 只回答一个问题：一轮请求开始前，Pi 先把哪些东西拍成快照。

## 建议读法

先看 [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts) 的 331-362 行。那里就是 `createTurnState()`。

然后看 365-373 行。`createContext()` 从 turn state 里拿出 provider 真正需要的三样东西：systemPrompt、messages、activeTools。

最后看 `harness/types.ts` 的 `AgentHarnessOptions`。它能看出这些字段从哪里传进来。
