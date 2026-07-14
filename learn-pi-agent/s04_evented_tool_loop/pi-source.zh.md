# s04 的 Pi 0.79.1 源码对照

s04 在正式的 `pi-ai` Assistant Message Stream 外层，加入 `pi-agent-core` 使用的主要生命周期边界。

```text
agent -> turn -> assistant message -> tool execution -> toolResult message
```

## 对应文件

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)

## 对应关系

| s04 | Pi 0.79.1 |
| --- | --- |
| `runEventedToolLoop()` | `runAgentLoop()` / `runLoop()` 中的 Tool Call 主路径 |
| s03 `collectAssistantStream()` | Pi `streamAssistantResponse()` 内消费的 Stream |
| `AgentEvent` | Pi `AgentEvent` Union 的教学版子集 |
| `message_update.providerEvent` | Pi Agent Event 中名为 `assistantMessageEvent` 的字段 |
| `createRegistryToolRuntime().execute()` | `executeToolCalls()` 下的准备、校验与执行路径 |
| `ToolExecutionContext.executeDefault()` | 包围默认执行的课程显式接口 |
| `tool_execution_start/end` | Pi Tool Execution 生命周期 Event |
| Tool Result `message_start/end` | Pi 的 Tool Result Message 发出过程 |
| `turn_end` | 记录 Tool Result 后完成的 Pi Turn |

课程直接使用 Pi 的 `Message`、`AssistantMessageEvent`、`ToolCall` 和 `ToolResultMessage` 类型。外层 `AgentEvent` 是课程本地类型，因为本课正在重建 Agent Runtime 层。

## Event 由哪一层拥有

两组 Event 分别属于不同层：

```text
pi-ai
  start, text_*, thinking_*, toolcall_*, done, error

pi-agent-core
  agent_*, turn_*, message_*, tool_execution_*
```

s04 把第一组保存在 `message_update` 中，再围绕完整 Loop 发出第二组。这样可以复现源码边界，而不是把所有 Event 压成一组互不相关的字符串。

## s04 做了哪些简化

课程按顺序执行 Tool Call，并保持它们在 Assistant Message 中的顺序。Pi 还支持每个 Tool 的 Execution Mode、并行执行、Tool 进度更新、参数准备、Abort Signal、Steering Message 和 Follow-up Queue。

课程加入八个 Turn 的兜底上限；Pi 则根据 Tool Call 与 Queue State 决定是否继续。课程把 User Message 保存在 State 与 `agent_start.prompt` 中，而 Pi 的完整 Event Sequence 还可以为 Prompt Message 发出生命周期 Event。

`ToolCallExecutor` 和 `executeDefault()` 是课程为了在 s05 加入 Hook 而设计的小型接口。它们对应 Pi 内部的准备与收尾边界，不是 Pi 中同名类型的复制。

## 建议读法

1. 先看 [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts) 中的 `AgentEvent`。
2. 从 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 的 `runAgentLoop()` 与 `runLoop()` 进入。
3. 继续跟踪 `streamAssistantResponse()`，观察 Provider Event 如何转换成 Message 生命周期 Event。
4. 沿 `executeToolCalls()` 追踪顺序执行与 Tool Result 发出过程。
5. 看到 `beforeToolCall` 与 `afterToolCall` 边界时停下，下一课会展开它们。
