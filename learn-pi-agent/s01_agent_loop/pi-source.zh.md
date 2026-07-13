# s01 的 Pi 源码对照

s01 只保留 Pi agent loop 的最小形状：

```text
user input
  ↓
messages
  ↓
provider
  ↓
assistant message
  ↓
stopReason
```

## 对应文件

- [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)

## 对应关系

| s01 | Pi |
| --- | --- |
| `AgentState.messages` | `AgentContext.messages` |
| `Provider.complete()` | `streamAssistantResponse()` 里的 provider stream |
| `runOneTurn()` | `runAgentLoop()` 加 `runLoop()` 的最小路径 |
| `AssistantMessage.stopReason` | Pi `AssistantMessage.stopReason` |
| `toolUse` 暂不执行 | Pi 会进入 `executeToolCalls()` |

## 现在先不学什么

Pi 的 `agent-loop.ts` 还处理这些事：

```text
EventStream
transformContext()
convertToLlm()
streaming delta
tool execution
beforeToolCall / afterToolCall
steering messages
follow-up messages
shouldStopAfterTurn()
```

这些都不是 s01 的内容。s01 只确认一件事：agent loop 不是神秘结构，它先是一段围绕 messages 和 stopReason 的控制流。

Pi 的 `StopReason` 定义在 [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)。其中 `stop` 表示普通结束，`toolUse` 表示 assistant 消息里包含工具调用。s01 保留这两个值，但不执行工具。

## 建议读法

先读 [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md) 里的 `prompt() Event Sequence`。

然后看 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 里的这几个位置：

```text
agentLoop()
runAgentLoop()
runLoop()
streamAssistantResponse()
```

看到 provider event stream 时可以先跳到 s03。看到 tool execution 就停，那是 s04 的内容。
