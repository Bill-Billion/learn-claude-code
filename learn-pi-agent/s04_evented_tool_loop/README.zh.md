# 第 4 课 · Evented Tool Loop

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：包围正式 `pi-ai` Provider Stream 的 Agent、Turn、Message 与 Tool Execution 生命周期。

```text
Agent lifecycle
  -> Turn lifecycle
     -> Message lifecycle
     -> Tool Execution lifecycle
```

## 先搞懂：为什么 Provider Event 还不够

s03 已经暴露一条 Assistant Message 生成期间的全部变化，但一次 Agent Run 比单次 Provider Response 更大。它可以包含多个模型 Turn、Tool Call、Tool Result、错误和最终回答。

如果 Runtime 只转发 Provider Event，消费者就无法可靠回答更外层的问题：Agent Run 什么时候开始和结束，哪些 Event 属于同一个 Turn，Tool 什么时候实际执行，以及 Tool Result 什么时候作为 Message 加入状态。

## 思路：在同一条循环外再加一层事件

保留模型工具闭环，在外层加入第二套 Event：

```text
agent_start
  turn_start
    message_start / message_update / message_end   assistant
    tool_execution_start / tool_execution_end
    message_start / message_end                    toolResult
  turn_end
  ... next turn ...
agent_end
```

Provider Event 仍然保存在 `message_update` 内。Agent Event 描述更大的 Runtime 生命周期，不会改变 Provider Protocol。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s04
```

下面的单次请求会经过两个模型 Turn：

```bash
npm run s04 -- "使用 read_file 读取 README.md，然后总结 Learning Path 部分。"
```

最终回答和 Provider Delta 数量可能变化。稳定行为是生命周期嵌套：一次 Agent Run 包含一个或多个 Turn，Assistant 与 Tool Result Message 都有明确边界，每次完成的默认 Tool Execution 都有开始和结束 Event。

CLI 输出最终文本。返回结果中的 `events` 数组和可选 `onEvent` Callback 则把生命周期提供给其他运行外壳或观察者。

## 代码怎么写的

### 1. 在 Runtime 层定义 Event

`AgentEvent` 把四类问题分开：

```text
agent_start / agent_end
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / tool_execution_end
```

每条 Event 都携带对应数据，包括 Turn Number、Partial 或 Final Message、Provider Event、Tool Call 和 Tool Result。消费者不必再从原始文本猜测 Runtime 阶段。

### 2. Agent 生命周期只打开和关闭一次

`runEventedToolLoop()` 追加 User Message，发出 `agent_start`，再进入 `try` Block。`closeLifecycle()` 是幂等函数，因此正常完成、显式终止、Provider 失败和轮数耗尽都会且只会用一个 `agent_end` 收尾。

### 3. 把一次 Provider Stream 转成 Message Event

每个 Turn 都会调用 s03 的 `collectAssistantStream()`。Callback 按下面的规则映射正式 Event：

```ts
if (providerEvent.type === "start") {
  emit({ type: "message_start", turn, message: providerEvent.partial });
} else if (providerEvent.type !== "done" && providerEvent.type !== "error") {
  emit({
    type: "message_update",
    turn,
    message: providerEvent.partial,
    providerEvent,
  });
}
```

收集完成后，终态 Assistant Message 会追加到 State，并通过 `message_end` 发出。

### 4. 为 Tool Execution 建立单独的生命周期

在默认执行路径中，每个 Tool Call 都会发出 `tool_execution_start`，运行 Registry Handler，追加 Tool Result，再发出 `tool_execution_end`。随后，Loop 还会为这条 Tool Result Message 发出 `message_start` 和 `message_end`。如果注入的 Executor 抛出错误，外层 Agent 生命周期会处理异常，因此会在 Execution End Event 之前用 `agent_end` 关闭。

多个 Tool Call 按照 Assistant Message 中的顺序逐个执行。未知工具和 Handler 失败仍然变成 Error Tool Result，因此下一个模型 Turn 可以处理错误。

### 5. 记录完结果后才结束 Turn

`turn_end` 包含终态 Assistant Message 和当前 Turn 生成的 Tool Result。没有 Tool Call 时，Agent 正常结束；否则，这些 Tool Result 会成为下一个 Turn 的上下文。

可选的 `executeToolCall` 边界接收 `ToolExecutionContext` 与 `executeDefault()` 函数。s05 会使用这个扩展点在执行周围增加策略，而不重写 Loop。

## 动手试一试

1. 从 `runLiveCli()` 传入 `onEvent: (event) => console.log(event.type)`。分别运行直接问题和文件读取请求，比较二者的 Turn 数量。
2. 让模型读取两个指定文件。确认每个 Tool Call 都有自己的执行 Event，Tool Result 仍保持模型给出的顺序。
3. 暂时设置 `maxTurns: 1` 并请求读取文件。确认出现明确的轮数上限错误后，生命周期最后一条仍然是 `agent_end`。

## 接入课程主线

| 边界 | s03 | s04 |
| --- | --- | --- |
| Provider Event | 正式 `AssistantMessageEvent` | 保存在 `message_update` 内 |
| Runtime Event | 无 | `AgentEvent` 生命周期 |
| Loop 入口 | `runStreamingAgentLoop()` | `runEventedToolLoop()` |
| Tool Execution | Registry Runtime | 同一执行过程，外加 Start/End Event |
| 扩展点 | `onEvent` 观察 Provider Output | `onEvent` 观察 Runtime，`executeToolCall` 包围执行 |
| 完成结果 | 最终 Assistant Message | 最终消息加完整关闭的 Agent 生命周期 |

## 对照 Pi 源码

s04 围绕同一个正式 `pi-ai` Stream，重建 `pi-agent-core` 的主要生命周期形状。课程 Event Payload 更小，但 Agent、Turn、Message 与 Tool Execution 仍然是彼此独立的边界。

固定的 Pi 0.79.1 源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 5 课 · Tool Hooks](../s05_tool_hooks/) 会使用执行扩展点加入 `beforeToolCall` 和 `afterToolCall` 策略。
