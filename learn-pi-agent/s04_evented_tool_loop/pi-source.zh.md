# s04 的 Pi 源码对照

s04 对应 `pi-agent-core` 的工具执行主路径。

```text
assistant message with toolCall
  -> execute tool
  -> toolResult message
  -> next provider turn
```

## 对应文件

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)

具体锚点：

```text
agent-loop.ts:192-218  stream assistant, find tool calls, append tool results, emit turn_end
agent-loop.ts:275-367  streamAssistantResponse()
agent-loop.ts:373-388  executeToolCalls()
agent-loop.ts:395-449  executeToolCallsSequential()
agent-loop.ts:562-626  prepareToolCall()
agent-loop.ts:628-663  executePreparedToolCall()
agent-loop.ts:717-742  tool_execution_end and toolResult message events
types.ts:403-418       AgentEvent
ai/types.ts:303-311    ToolResultMessage
```

## 对应关系

| s04 | Pi |
| --- | --- |
| `runEventedToolLoop()` | `runAgentLoop()` / `runLoop()` 的最小工具路径 |
| `streamAssistant()` | `streamAssistantResponse()` |
| `AgentEvent` | Pi `AgentEvent` |
| `executeToolCall()` | `executeToolCallsSequential()` 的教学版 |
| `ToolResultMessage` | Pi `ToolResultMessage` |
| `tool_execution_start/end` | Pi 工具执行生命周期事件 |
| `message_start/end(toolResult)` | Pi 的 `emitToolResultMessage()` |

## 本节暂时不做什么

s04 只做顺序执行。真实 Pi 还包含：

```text
user / prompt message：Pi 的 runAgentLoop() 接收 prompts，并在首个 turn 里
  为 prompt 发 message_start/end；s04 的循环从空上下文起跑，真实 provider
  不可能这样开始
parallel 工具执行
per-tool executionMode
TypeBox 参数验证
prepareArguments
AbortSignal
tool_execution_update
beforeToolCall / afterToolCall
terminate=true 提前停止后续 provider turn
steering / follow-up message queue
maxTurns：mini 用 maxTurns=4 兜底；Pi 靠 hasMoreToolCalls 自然收敛，没有这个上限
```

还有一个改名要注意：mini 的 `message_update` 事件带的字段叫 `providerEvent`，Pi 里同位置的字段叫 `assistantMessageEvent`（`agent/src/types.ts:413`）。

这些会在后面拆开讲。s04 只回答一个问题：assistant 发出 toolCall 以后，结果如何回到 messages。

## 建议读法

先从 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 的 `agentLoop()`（31 行）和 `runAgentLoop()`（95 行）进入，再落到 192-218 行——这一段是 `runLoop()` 里工具循环的主体。

然后看 275-367 行。这里把 `pi-ai` 的 provider events 转成 agent events。

最后看 395-449 行和 717-742 行。那里能看到 Pi 如何执行工具，发出 `tool_execution_end`，再把执行结果包装成 `toolResult` message。
