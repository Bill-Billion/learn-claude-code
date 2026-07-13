# s03 的 Pi 源码对照

s03 只讲 `pi-ai` 的 provider event stream。

```text
provider stream
  -> AssistantMessageEvent
  -> partial AssistantMessage
  -> done.message
```

## 对应文件

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)
- [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/README.md)

具体锚点：

```text
types.ts:257-263       ToolCall
types.ts:280           StopReason
types.ts:288-301       AssistantMessage
types.ts:338-348       Tool / Context
types.ts:350-370       AssistantMessageEvent
stream.ts:40-75        stream / complete / streamSimple / completeSimple
event-stream.ts:69-87  AssistantMessageEventStream
README.md:374-393      complete event reference and contentIndex warning
```

## 对应关系

| s03 | Pi |
| --- | --- |
| `ProviderEvent` | `AssistantMessageEvent` |
| `EventProvider.stream()` | `streamSimple()` 返回的 `AssistantMessageEventStream` |
| `AssistantMessage.content` | Pi `AssistantMessage.content` |
| `ToolCall` | Pi `ToolCall` |
| `contentIndex` | Pi 事件里的 content block 索引 |
| `collectProviderStream()` | `for await ... of stream` 消费事件 |
| `done.message` | `AssistantMessageEventStream.result()` 的最终结果 |

## 本节暂时不做什么

s03 的代码没有实现这些内容：

```text
api / provider / model / usage 字段
thinking_start / thinking_delta / thinking_end
image content
真实 provider 的协议转换
validateToolCall()
工具执行和 toolResult message
```

这些不是遗漏。s03 的目标是让读者先看懂 provider event stream。工具执行从 s04 开始。

## 建议读法

先读 [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts) 里的 `AssistantMessageEvent`。这一段是本节最重要的源码。

然后看 [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)。`AssistantMessageEventStream` 做了两件事：一方面让调用者可以 `for await` 消费事件，另一方面在 `done` 或 `error` 到来时保存最终 assistant message。

最后看 [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)。`completeSimple()` 其实就是拿到 stream 后等待 `result()`。
