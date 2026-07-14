# s03 的 Pi 0.79.1 源码对照

s03 消费 `@earendil-works/pi-ai` 0.79.1 正式导出的 `AssistantMessageEvent` Stream。

```text
stream(model, context)
  -> AssistantMessageEventStream
  -> AssistantMessageEvent
  -> done.message or error.error
```

## 对应文件

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)
- [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/README.md)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)

## 对应关系

| s03 | Pi 0.79.1 |
| --- | --- |
| 导入的 `AssistantMessageEvent` | `packages/ai/src/types.ts` 中的同一套 Event Union |
| 导入为 `streamModel()` 的函数 | `packages/ai/src/stream.ts` 中的 `stream()` |
| `collectAssistantStream()` | `for await` 消费 `AssistantMessageEventStream`，并收集终态消息 |
| `event.type`、`contentIndex`、`partial` | 不做转换，直接使用正式 Event 字段 |
| `done.message` / `error.error` | 正式的终态 Assistant Message 字段 |
| `runStreamingAgentLoop()` | 围绕正式 Stream、Registry 和 Tool Result 的课程 Agent Loop |
| `onEvent` | 叠加在相同 Event Object 上的小型 Consumer Callback |

s03 不会再定义一套面向模型的 Provider Event Protocol。真实路径直接导入并消费 Package 的正式类型与 Stream。

## Provider Event 与 Agent Event

`pi-ai` Event 描述一条 Assistant Message 的构建过程：

```text
start
text_* / thinking_* / toolcall_*
done or error
```

`pi-agent-core` 再在外层加入 Agent Run、Turn、Message 与 Tool Execution 的生命周期。s04 会重建这层外部 Event。把两类 Event 分开，是本课最重要的源码边界。

## s03 增加了什么，又简化了什么

`collectAssistantStream()` 把 Event 存入数组，把每条 Event 转交可选 Callback，并记住最终消息。Pi 的 `AssistantMessageEventStream` 也能通过自身 Stream 抽象提供最终结果；课程把收集过程显式写出，便于观察协议。

本课 CLI 只展示 Text Delta，不实现 Terminal UI、Thinking Block 渲染、Usage 展示，也不暴露 Provider 特定的 Wire Event。Tool Execution 仍属于课程 Loop，而不是 `pi-ai`。

## 建议读法

1. 先看 [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts) 中的 `AssistantMessageEvent` 和 `AssistantMessage`。
2. 再看 [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)，理解 Async Iteration 与最终结果保存。
3. 阅读 [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts) 中的 `stream()` 和 `complete()`。二者的区别说明了为什么 s01 可以等待一条消息，而 s03 可以观察每条 Event。
4. 最后查看 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 中 Provider Event 到 Agent Event 的转换，这正是 s04 的主题。
