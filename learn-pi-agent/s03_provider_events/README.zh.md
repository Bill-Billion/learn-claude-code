# 第 3 课 · Provider Events

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：`@earendil-works/pi-ai` 正式提供的 `AssistantMessageEvent` Stream，Agent Runtime 会在下一课为它加入自己的生命周期 Event。

```text
provider bytes -> pi-ai events -> partial message -> final AssistantMessage
```

## 先搞懂：为什么不能只等待完整回答

调用方只需要最终 `AssistantMessage` 时，`complete()` 很方便。但 Runtime 还需要在生成过程中观察工作：文本正在到达、Tool Call 参数正在组装、响应已经完成，或者 Stream 发生错误。

只给文本加 Callback 仍然不够。文本和 Tool Call 可能位于不同 Content Block，多个 Block 可以交错，而且所有消费者都需要同一条终态消息。协议必须描述完整 Assistant Message，而不只是可打印字符。

## 思路：直接使用 `pi-ai` 的事件协议

`pi-ai` 已经提供下面的 Event Family：

```text
start
  -> text_start / text_delta / text_end
  -> toolcall_start / toolcall_delta / toolcall_end
  -> done or error
```

每条增量 Event 都带 `contentIndex` 和 Partial Assistant Message。`done.message` 或 `error.error` 提供终态消息。UI 渲染、日志和 Agent Loop 可以出于不同目的消费同一条 Stream。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s03
```

下面的单次请求更容易同时出现 Tool Call Event 与 Text Event：

```bash
npm run s03 -- "使用 read_file 读取 package.json，然后用两句话解释 scripts。"
```

具体 Delta、Tool Call 参数和回答都可能变化。CLI 会在 `text_delta` 到达时直接输出，再返回组装完成的最终文本。稳定契约是有序 Event Family 和最终 Assistant Message，而不是某种固定分块方式。

## 代码怎么写的

### 1. 消费正式 Stream

`collectAssistantStream()` 调用从 `@earendil-works/pi-ai` 导入的 `stream()`：

```ts
for await (const event of streamModel(model, context, streamOptions)) {
  events.push(event);
  onEvent?.(event);
  if (event.type === "done") message = event.message;
  if (event.type === "error") message = event.error;
}
```

本课不会自己转换 Provider Wire Data。安装的 `pi-ai` Provider 完成协议转换，并产出 `AssistantMessageEvent`。

### 2. 同时保留 Event 与终态消息

`CollectedAssistantStream` 返回同一个响应的三种视图：

```text
events      按顺序保存全部 AssistantMessageEvent
eventTypes  便于观察的紧凑类型列表
message     最终 AssistantMessage
```

如果 Async Iterable 在没有 `done` 或 `error` 的情况下结束，`collectAssistantStream()` 会抛出错误。没有终态消息的 Stream 不能算作一次完成的模型 Turn。

### 3. 让 Content Block 保持可寻址

Text 与 Tool Call Delta 都包含 `contentIndex`。消费者必须把每个 Delta 应用到对应 Content Block，不能假设所有输出都属于一个字符串。`partial` 快照则允许观察者渲染 Assistant Message 当前的状态。

### 4. 在同一条循环中流式处理每个模型 Turn

`runStreamingAgentLoop()` 保留 s02 Registry 和模型工具闭环。Model Boundary 唯一的变化，是每个 Turn 都改用 `collectAssistantStream()`：

```ts
const streamed = await collectAssistantStream({
  model,
  context: { messages: state.messages, tools: runtime.tools },
  streamOptions,
  onEvent,
});
```

终态 Assistant Message 到达后，Loop 会追加它，通过 Registry 执行 Tool Call，追加 Tool Result，再流式处理下一次模型调用。所有 Turn 的 Event 都按顺序放进同一个数组返回。

### 5. 让消费者决定展示什么

CLI 的 `onEvent` 只输出 `text_delta`。其他消费者可以记录 Tool Call Delta、渲染进度视图，或转发完整 Event Object。`readTextBlocks()` 负责从终态消息中提取完整 Text Block，但它本身不是流式协议。

## 动手试一试

1. 在 `runLiveCli()` 的 `onEvent` 中输出 `event.type`。运行一个直接问题，列出一段文本周围的 Event 顺序。
2. 运行上面的单次文件请求，在第二次模型 Turn 前观察 `toolcall_start`、一个或多个 `toolcall_delta` 和 `toolcall_end`。
3. 输出每条 Text 与 Tool Call Event 的 `contentIndex`。确认消费者无需依赖到达时间或分块大小，就能区分不同 Block。

## 接入课程主线

| 边界 | s02 | s03 |
| --- | --- | --- |
| Model Call | s01 Loop 内的 `complete()` | 通过 `collectAssistantStream()` 使用 `pi-ai` `stream()` |
| Provider Output | 最终 Assistant Message | 有序 `AssistantMessageEvent[]` 加最终消息 |
| Tool Boundary | Registry | 同一个 Registry |
| Loop 入口 | `runToolRegistryAgentLoop()` | `runStreamingAgentLoop()` |
| Consumer Hook | 只有最终结果 | 每个模型 Turn 中的 `onEvent(event)` |

## 对照 Pi 源码

`AssistantMessageEvent`、`Context`、`stream()` 和终态消息语义直接来自 `@earendil-works/pi-ai` 0.79.1。s03 只增加收集过程和课程外层 Loop，不会再定义第二套 Provider Protocol。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 4 课 · Evented Tool Loop](../s04_evented_tool_loop/) 会在这些 Provider Event 外层加入 Agent、Turn、Message 和 Tool Execution 生命周期 Event。
