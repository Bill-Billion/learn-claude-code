# s14 对照 Pi 源码

s14 对应 Pi 的 OpenAI Chat Completions provider 边界。课程源码快照仍固定在 `@earendil-works/pi-ai` 0.79.1，commit 为 `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`。

## 相关文件

- [`packages/ai/src/providers/openai-completions.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/openai-completions.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)
- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/coding-agent/docs/custom-provider.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/custom-provider.md)

## 应该找什么

阅读 `openai-completions.ts` 时，按四类职责追踪，不要寻找一个和本课同名的 class：

1. 把 context 与工具定义转换为 Chat Completions 请求消息；
2. 把流式响应 delta 转换为 Pi `AssistantMessageEvent`；
3. 把工具调用的 id、name 和 argument string 累积成完整调用；
4. 在标准化 event 离开 `pi-ai` 前处理 provider/model 兼容性。

接着沿着 `stream.ts` 和 `event-stream.ts` 把标准化 stream 追到 `agent-loop.ts`。Provider 不执行 coding tool，它只产生所有 Pi provider 都必须提供的模型消息和 event 类型。工具验证、hook 派发、执行和 tool-result 插入仍然属于 agent 层。

## 映射关系

| s14 | Pi |
| --- | --- |
| `createOpenAICompatibleProvider()` | OpenAI Chat Completions streaming provider |
| `createChatCompletionRequest()` | provider 调用前的 context/message/tool 转换 |
| `readSseData()` | OpenAI client/stream 边界负责的传输解析 |
| 按 `index` 建立的工具 accumulator | completions provider 中的流式工具调用拼接 |
| 输出 `ProviderEvent` | Pi 标准化 `AssistantMessageEvent` stream |
| `OpenAIProviderError` | 进入 agent 执行前的 provider/stream 错误路径 |
| `createLiveHarnessRuntime()` | provider selection 接入现有 harness/session 装配 |

## 有意保留的差异

真实 Pi provider 支持更大的兼容面：不同模型家族、system/developer role 行为、reasoning 格式、图片、usage 与成本统计、context overflow 检测、provider 特有字段，以及 SDK 层的 abort/error 行为。s14 只保留暴露协议边界所需的文本与 function-call 路径。

s14 还直接使用 Node stream 解析 SSE，让字节 framing 对学习者保持可见。Pi 使用持续维护的 provider/client integration 和兼容代码，因为生产支持与演示不变量是两个不同问题。

受限的 `read_course_file` 是课程代码，不是 Pi provider 功能。它只用于展示真实 model -> tool -> result -> model 闭环，同时避免给结课项目任意文件系统或 shell 权限。

## 建议阅读顺序

先读 [`openai-completions.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/openai-completions.ts) 中的请求与 stream 转换，同时打开 [`types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)，对照每个 provider-specific delta 最终产生的标准 event。

然后读 [`event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts) 和 [`stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)。最后进入 [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)，看标准化 event 如何成为 assistant message，以及工具调用如何进入执行路径。
