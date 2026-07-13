# s05 的 Pi 源码对照

s05 对应 `pi-agent-core` 的工具 hook。

```text
tool_execution_start
  -> beforeToolCall
  -> execute tool
  -> afterToolCall
  -> tool_execution_end
  -> toolResult message
```

## 对应文件

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md)

具体锚点：

```text
types.ts:49-58        BeforeToolCallResult
types.ts:60-81        AfterToolCallResult
types.ts:83-108       hook context types
types.ts:256-262      beforeToolCall config entry（签名在 262 行）
agent-loop.ts:562-626 prepareToolCall()
agent-loop.ts:665-708 finalizeExecutedToolCall()
agent/README.md:111-113 hook order and terminate behavior
agent/README.md:196-210 config examples
```

## 对应关系

| s05 | Pi |
| --- | --- |
| `ToolHooks.beforeToolCall` | `AgentLoopConfig.beforeToolCall` |
| `ToolHooks.afterToolCall` | `AgentLoopConfig.afterToolCall` |
| `{ block: true, reason }` | Pi `BeforeToolCallResult` |
| `{ content, isError, terminate }` | Pi `AfterToolCallResult` 的教学版 |
| `runHookedToolLoop()` | `runAgentLoop()` 的带 hook 工具路径 |
| `terminated` | Pi tool result 的 `terminate` hint |
| batch 全 terminate 才提前停 | `agent-loop.ts:544-546` 的 `every()` 判定 |

两个字段级差异：Pi 的 hook context 传的是 `context: AgentContext`（`types.ts:92, 107`），mini 换成了 `messages: LoopMessage[]`；Pi 的 `afterToolCall` 收到的是 `AgentToolResult`（还不是 message），mini 直接给了包装好的 `ToolResultMessage`。

## 本节暂时不做什么

s05 没有实现这些内容：

```text
TypeBox 参数验证后再调用 beforeToolCall
AbortSignal
details 字段改写
parallel 工具执行
permission popup
project trust
```

terminate 的批量语义 mini 已经和 Pi 对齐：只有当一批 toolCall 的每个结果都要求 terminate 时才提前停，混合批次照常进入下一轮（Pi `agent/README.md:113` "Mixed batches continue normally"）。

这些不是同一层问题。Pi 的 `beforeToolCall` 可以被拿来做权限或审计，但权限 UI 不是 agent-core 的内置机制。后面讲 Trust And Execution Env 时再回到这个边界。

## 建议读法

先看 [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts) 的 `BeforeToolCallResult` 和 `AfterToolCallResult`。这里定义了 hook 能返回什么。

然后看 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 的 `prepareToolCall()`。`beforeToolCall` 返回 block 时，Pi 会创建一条错误结果，不执行工具。

最后看 `finalizeExecutedToolCall()`。`afterToolCall` 返回 patch 时，Pi 逐字段替换工具结果。
