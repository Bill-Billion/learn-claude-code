# s14 · Real Provider

[English](README.md) | 中文 | [日本語](README.ja.md)

[← s13](../s13_integrated_harness/README.zh.md) | [目录](../README.zh.md)

> 一句话：s14 把 OpenAI-compatible Chat Completions SSE 转换为 s03 的 `ProviderEvent` 协议，再让真实模型驱动 s13 已经集成好的工具循环。
>
> 它在 Pi 中的位置：`pi-ai` 的 provider 层，紧邻 `pi-agent-core` 消费标准化 assistant event 之前。

→ 离线 fixture 证明 harness 机制可确定复现；真实 provider 证明模型确实能够选择下一步行动
→ SSE chunk 只是传输分片，不是语义事件：UTF-8 字节、SSE record、JSON delta 和工具参数需要在四个不同边界拼接
→ 工具参数是不可信的模型输出：完整字符串没有解析成 JSON object、registry 没有验证通过之前，绝不能执行

---

## 问题

s01 到 s13 有意使用确定性 provider。这样，事件顺序、工具执行、会话存储、extension hook、trust 和 package 解析都容易学习，也能安全测试。但它留下了一个重要问题：这些接口遇到真实模型流时还能成立吗？

真实的 Chat Completions 响应不会一次返回一个 `AssistantMessage`。它是一串任意切分的字节，其中包含 SSE record。每个 JSON record 可能只带一段文本、一段工具 id、一段函数名，或者函数 JSON 参数的一部分。请求也可能在拿到 body 前失败、读取 body 时失败，或者在只收到部分语义响应后中断。

错误的捷径，是对每个网络 chunk 直接按 `\n\n` 切分，再逐个 `JSON.parse()`。网络 chunk 不会尊重 UTF-8 code point 或 SSE record 边界。即使 SSE 已经解析完成，`tool_calls[].function.arguments` 在调用结束前仍然只是一个不完整字符串。

因此 s14 只增加一层窄适配器，不修改前面已经建立的循环、registry、session 和 runtime 契约。

## 思路

出站路径转换现有 `ProviderContext`：

```text
systemPrompt             -> system message
user message             -> user message
assistant text/toolCall  -> assistant content/tool_calls
toolResult               -> 带 tool_call_id 的 tool message
ToolDefinition           -> function tool schema
```

入站路径按顺序拆开传输层：

```text
ReadableStream<Uint8Array>
  -> streaming TextDecoder
  -> 完整 SSE record
  -> JSON chat-completion chunk
  -> text/tool-call accumulator
  -> s03 ProviderEvent
  -> s05 tool loop
  -> s13 session + runtime
```

适配器只有在同时看到支持的 `finish_reason` 和结尾 `[DONE]` record 后，才会发出 `done`。这一点很重要：半途断开的 stream 绝不能放出不完整的工具调用去执行。

## 先跑起来

测试完全离线：

```bash
npm run test:s14
```

要运行真实结课项目，请配置一个支持流式 Chat Completions 和 function/tool call 的 OpenAI-compatible 端点：

```bash
cp .env.example .env
# 填写 OPENAI_API_KEY 和 OPENAI_MODEL。
# OPENAI_BASE_URL 默认为 https://api.openai.com/v1。

npm run session:s14 -- "读取 README.md，用三点解释这门课程"
```

命令通过 Node 的 `--env-file-if-exists` 参数加载 `.env`。它创建 s13 的集成 runtime，暴露 `read_course_file`，最后打印模型回答。这个工具把根目录固定在 `learn-pi-agent` 模块位置，而不是调用时的 `cwd`；它会解析符号链接，并且只接受课程内不超过 50,000 字节的非隐藏普通 UTF-8 文件。

前面任何一节、`npm run test:s14` 和 `npm run check` 都不需要 Key。只有 `session:s14` 会发送网络请求。

## 代码怎么工作的

### 1. 配置保持显式

`loadOpenAICompatibleConfig()` 要求提供 `OPENAI_API_KEY` 和 `OPENAI_MODEL`，`OPENAI_BASE_URL` 默认使用官方 `/v1` 根地址。缺少配置时，会在 `fetch` 之前失败，并在错误信息中指向 `.env.example`。

Provider factory 还接受注入的 `fetch` 和 `AbortSignal`。生产运行使用 `globalThis.fetch`，测试使用内存 `Response`。Live 请求默认 60 秒超时。适配器不用 SDK，也没有生产依赖。

### 2. 按角色转换消息

`createChatCompletionRequest()` 使用结构化转换，不做 JSON 形状的字符串替换。富 assistant block 会变成 OpenAI-compatible assistant message：

```ts
{
  role: "assistant",
  content: null,
  tool_calls: [{
    id: "call_1",
    type: "function",
    function: { name: "read_course_file", arguments: "{\"path\":\"README.md\"}" },
  }],
}
```

对应的 s04/s05 `toolResult` 会变成携带相同 `tool_call_id` 的 `tool` message。这个身份标识让模型能把证据与自己请求的行动对应起来。只要存在工具，请求就会设置 `parallel_tool_calls: false`；如果兼容端点忽略这个设置，适配器仍会强制每次响应最多包含一个工具调用。

### 3. SSE 解析尊重字节边界

`readSseData()` 使用一个 streaming `TextDecoder`，在多次 read 之间保留未完成的文本 buffer，只交出完整 SSE record。注释和 `data` 之外的字段不会变成 provider event；同一 record 中的多个 `data:` 行会按照 SSE 规则合并。

测试会把中文 UTF-8 响应按 1、2、5 字节边界切分。通过这项测试，说明传输分块不会破坏 code point 或 JSON document。流式 `refusal` 也会转换为可见文本，不会悄悄变成空白的成功结果。

### 4. 按 index 累积工具调用

Chat Completions 使用 `index` 标识流式工具调用。第一个 delta 创建一个 s03 content block，并发出 `toolcall_start`；后续 delta 把 `id`、`function.name` 和 `function.arguments` 分片追加到同一个 accumulator。这个结课项目每次响应只接受一个调用；出现第二个 index 时，会在任何工具执行前把整条响应判为协议错误。

只有收到 `finish_reason: "tool_calls"` 时，`finalizeToolCall()` 才解析参数字符串，而且必须得到 JSON object。随后 s02 registry 会在调用 handler 前执行自己的 schema 检查。这是两个边界：JSON 解析回答“它是否是完整 object”，registry 验证回答“它是否是这个工具的有效输入”。

### 5. 失败保持可见

`OpenAIProviderError.kind` 区分：

| Kind | 示例 | 适配器行为 |
| --- | --- | --- |
| `authentication` | HTTP 401/403 | 保留状态码和 provider message |
| `rate_limit` | HTTP 429 | 报告一次，不重试 |
| `http` | 其他非 2xx | 保留状态码和有限长度的响应细节 |
| `network` | 连接或 body 读取失败 | 把底层错误保留为 cause |
| `aborted` | `AbortSignal` / `AbortError` | 用明确的 aborted error 停止 |
| `protocol` | 畸形 JSON、非法 delta、缺少 finish 或 `[DONE]` | 拒绝不完整 assistant 响应 |

所有失败都会统一成为 s03 定义的终态 `ProviderEvent.error`。这样 s05 能够正常闭合 `message_end`，任何不完整工具调用也不会执行。Live CLI 会观察同一个错误，在 harness 生命周期闭合后以非零状态退出；library consumer 仍然只消费一条完整 event stream，不会多出一条只靠 throw 的错误通道。

这里故意不自动重试。生产级 retry policy 需要同时考虑幂等、backoff、provider header、取消和可观测性。把这些决策藏进第一个适配器，会教错边界。

教学适配器也会限制远端输入：单个 SSE event 最多 1,000,000 个解码字符，完整 SSE 响应最多 4,000,000 字节，HTTP 错误 body 最多读取 64,000 字节。超时或超过上限都会变成同一条终态 error event，未读完的 reader 会被取消。Live Loop 最多允许四轮模型调用；如果第四轮仍在请求工具，CLI 会报告轮数耗尽并以非零状态退出，而不是把空字符串当成成功结果。这些是教学规模的保护线，不是生产容量建议。

## 真实工具闭环

Live 命令不会创建第二套 Agent 实现。它把真实 provider 和一个受限文件读取 registry 传给 s13 的 `createIntegratedHarnessRuntime()`：

```text
用户问题
  -> 真实模型请求 read_course_file
  -> s14 发出 toolcall event
  -> s05 验证并执行工具
  -> s13 存储 assistant + toolResult
  -> s14 把两者转换为第二次 API 请求
  -> 真实模型根据文件内容回答
```

这就是课程的最终验收。模型是真的，harness 仍然是之前逐节组装起来的那一个。

## 试一试

1. 把 `OPENAI_BASE_URL` 指向另一个兼容端点，并选择支持工具的模型。运行同一个问题。如果失败，判断差异发生在 HTTP、SSE、消息形状还是工具调用语义。

2. 增加第二个受限工具，例如 `list_course_files`。不要修改 provider 或 loop。如果增加工具需要修改这两处，就要重新检查 s02 的边界。

3. 给 provider 传入 `AbortController.signal`，在第一个 `text_delta` 后中止。确认后面不会出现 `done` 或工具执行。

4. 增加一个包含两个工具调用 index 的 fixture，即使请求已经禁用并行调用。确认适配器发出协议错误、两个 handler 都不执行，而且 Harness 不会继续请求 Provider。

完成后运行 `npm run check`。它必须保持离线。

## 接入主线

| 关注点 | 复用章节 | s14 的职责 |
| --- | --- | --- |
| 工具定义与验证 | s02 | 序列化模型可见 schema |
| Provider event 契约 | s03 | 发出标准化 text/tool event |
| 工具执行与结果 | s04/s05 | 把结果转换回 API message |
| Turn context | s06 | 序列化 system prompt、history 和 active tools |
| Session 与 resource | s07/s08 | 不增加新行为 |
| Extension 与 policy | s09/s11 | 不增加新行为 |
| Runtime 与 integration | s10/s13 | 创建并驱动同一个 runtime |

s14 是叶子适配器。前面的章节不会 import 它，默认测试路径也不需要凭据。

## 对照 Pi 源码

映射见 [pi-source.zh.md](pi-source.zh.md)。先看 Pi 的 OpenAI Chat Completions provider，再沿标准化 event 进入 `agent-loop.ts`。比较的是职责，而不是行数：真实 Pi 还处理多个模型家族、reasoning 格式、usage、成本、图片和兼容性 flag，这些都被教学适配器有意排除。

协议层行为参考官方 [Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat) 和 [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)。尤其是，流式 `tool_calls[index]` delta 会先累积，JSON 参数验证通过后才会执行。

## 本节有意省略什么

- Responses API 和 provider 专用 API
- 图片、音频、reasoning block 与多模态工具结果
- token usage、价格和 context window 统计
- 并行重试、fallback model、backoff 与 resume
- 非标准 role 或字段的厂商兼容 flag
- TLS/proxy 配置与生产 secret 管理
- 终端逐 token 渲染

这些省略定义了结课项目的边界，不代表生产 provider 很简单。

## 收尾

s03 定义了循环应该接收什么。s13 证明了所有 harness 机制可以围绕这个契约组合。s14 最终展示了这层抽象为什么值得存在：网络协议可以从内存 fixture 换成真实 SSE，而工具循环不需要重写。

离线可复现与真实模型学习并不矛盾。前者应该是地基，后者应该是显式、可检查的结课项目。
