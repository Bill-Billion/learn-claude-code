# s01 的 Pi 0.79.1 源码对照

s01 直接使用 `@earendil-works/pi-ai`，并在外层加入 Pi 模型工具循环的最小教学实现。

```text
user -> complete() -> toolCall -> execute -> toolResult -> complete()
```

## 对应文件

- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/validation.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)

## 对应关系

| s01 | Pi 0.79.1 |
| --- | --- |
| 从 `pi-ai` 导入的 `complete()` | `packages/ai/src/stream.ts` 中的 `complete()` |
| `Message`、`ToolCall`、`ToolResultMessage` | `packages/ai/src/types.ts` 中的同名公开类型 |
| `validateToolCall()` | `packages/ai/src/utils/validation.ts` 中的同名校验入口 |
| `AgentState.messages` | `AgentContext` 内的消息历史 |
| `runAgentLoop()` | Pi `runAgentLoop()` / `runLoop()` 中最小的模型工具路径 |
| `readFileTool` | 教学版的模型可见 `Tool`，概念上对应 Coding Agent 的 Read Tool |
| `createReadFileToolRuntime()` | `AgentTool` 的本地执行一侧 |

关键边界已经使用真实实现：s01 把 Pi 的 `Message[]` 和 `Tool[]` 交给 Pi 的 `complete()`。课程只负责外层循环和一个有意缩小的文件工具。

## s01 做了哪些简化

Pi Agent Loop 还包含生命周期 Event、上下文转换、自定义消息转换、Steering 与 Follow-up Queue、Abort、工具进度、Hook 和并行工具执行。这些问题会在后续课程中分别展开。

s01 采用了更窄的范围：

```text
一个只读工具
顺序执行 Tool Call
最多八个模型 Turn 作为兜底
课程根目录内的文件访问，并检查隐藏路径、符号链接、大小和 UTF-8
使用 complete()，暂不向上暴露 Provider Event Stream
```

`read_file` 周围的安全策略属于课程实现，不能当作 Pi Coding Agent Read Tool 的完整复制。

## 建议读法

1. 先看 [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts) 中的 `Tool`、`ToolCall`、`ToolResultMessage`、`Message` 和 `AssistantMessage`。
2. 再看 [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts) 中的 `complete()`。
3. 沿 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 的 `runAgentLoop()` 进入 `runLoop()`，重点追踪 Assistant Message、Tool Call、Tool Result 和下一轮调用。
4. 最后对照 [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts) 中 Read Tool 的公开 Schema 与可执行部分。

s03 会暴露 Provider Event，s04 再加入 Agent 生命周期 Event。
