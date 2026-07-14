# 第 1 课 · Agent Loop

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：`pi-ai` 与 Agent Loop 的最小可用路径，从 User Message 进入，到模型选择 Tool Call、Harness 返回 Tool Result，再由模型给出最终回答。

```text
model -> toolCall -> toolResult -> model
```

## 先搞懂：为什么一次模型调用还不是 Agent

一次模型请求可以返回文本，但 Agent 还必须处理模型提出的行动请求。模型发出 Tool Call 后，程序需要执行工具，把结果追加进消息历史，再次调用模型。如果把工具输出直接交给用户，就跳过了模型理解这份证据的过程。

所以第一课不只需要一个 Chat Wrapper，还需要带显式状态、工具边界和停止条件的循环。

## 思路：围绕消息历史重复同一个过程

维护一个有序的 `messages` 数组，不断执行下面的步骤：

```text
追加 user message
  -> 用 messages + tools 调用模型
  -> 追加 assistant message
  -> 没有 toolCall：返回
  -> 有 toolCall：执行并追加 toolResult
  -> 再次调用模型
```

是否调用 `read_file` 由模型选择。文件读取、安全校验，以及把结果送回模型的 Message 都归 Harness 管理。

## 先跑起来看看

先按照[课程首页](../README.zh.md)完成 `.env` 配置，再从 `learn-pi-agent/` 运行：

```bash
npm run s01
```

不带参数时，命令会进入交互输入循环。需要重复观察同一个请求时，可以使用单次运行：

```bash
npm run s01 -- "使用 read_file 读取 package.json，然后告诉我 package name。"
```

具体回答和措辞可能变化，因为 Tool Call 和最终回复都由模型选择。请观察稳定的结构：第一轮模型请求 `read_file`，Harness 返回 `toolResult`，第二轮模型根据结果回答。

## 代码怎么写的

### 1. 加载真实的 `pi-ai` 模型

`runLiveCli()` 调用 `loadCourseModel()`。它读取 `OPENAI_API_KEY`，构造 OpenAI-compatible `Model<"openai-completions">`。`OPENAI_MODEL` 默认是 `gpt-4o-mini`，`OPENAI_BASE_URL` 默认使用 OpenAI 官方 API。

### 2. 定义一个安全工具

`readFileTool` 是正式的 `pi-ai` `Tool`。它的 TypeBox Schema 是模型看到的公开契约，`createReadFileToolRuntime()` 则把可执行的文件读取 Handler 留在 Harness 一侧。

Handler 只接受课程根目录内的普通 UTF-8 文件。空路径、隐藏路径段、越过根目录的路径或符号链接、非普通文件，以及超过 64 KiB 的文件都会被拒绝。

### 3. 显式保存循环状态

`AgentState` 管理有序的 `Message[]`。`runAgentLoop()` 先追加 User Message，再进入模型循环：

```ts
for (let turn = 0; turn < maxTurns; turn++) {
  const assistantMessage = await complete(model, {
    messages: state.messages,
    tools: toolRuntime.tools,
  }, streamOptions);
  state.messages.push(assistantMessage);

  const toolCalls = assistantMessage.content.filter(
    (block) => block.type === "toolCall",
  );
  if (toolCalls.length === 0) {
    return { state, finalMessage: assistantMessage, toolResults };
  }

  for (const toolCall of toolCalls) {
    state.messages.push(await toolRuntime.execute(toolCall));
  }
}
```

完整实现还会传入 System Prompt、记录每条 Tool Result，并同时返回最终 Assistant Message 与完整状态。

### 4. 把工具失败变成模型可见的证据

`executeToolCallSafely()` 把参数校验和文件错误转换成 `isError: true` 的 `ToolResultMessage`。循环可以继续，让模型解释失败或选择其他动作。Provider 返回 `error` 或 `aborted` 时会抛出异常；默认八轮上限则防止工具循环无限继续。

## 动手试一试

1. 先让模型读取 `README.md`，再读取 `package.json`。比较回答引用了哪个文件，不要要求两次措辞完全相同。
2. 运行 `npm run s01 -- "使用 read_file 读取 .env，并解释执行结果。"`。工具应拒绝隐藏路径，模型会把这次失败作为 Tool Result 接收。
3. 暂时在 `runLiveCli()` 中传入 `maxTurns: 1`，再请求读取文件。第一轮工具可以执行，但缺少后续模型 Turn 时应出现明确的轮数上限错误。

## 接入课程主线

| 边界 | s01 实现 |
| --- | --- |
| Model | `loadCourseModel()` 加 `pi-ai` `complete()` |
| State | `AgentState.messages` |
| 模型可见工具 | `readFileTool` |
| 本地执行 | `createReadFileToolRuntime()` |
| Loop 入口 | `runAgentLoop()` |
| 停止条件 | 没有 Tool Call、Provider 失败或耗尽 `maxTurns` |

s01 暂时把 Tool Schema 和 Handler 放在一个小型 Runtime Object 中。s02 会把模型可见 Schema 与私有 Handler Registry 分开。

## 对照 Pi 源码

实现直接使用 `@earendil-works/pi-ai` 0.79.1 提供的 `Model`、`Message`、`Tool`、`ToolCall`、`ToolResultMessage`、参数校验和 `complete()`。外层控制流是 Pi Agent Loop 的教学版。

固定版本的源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 2 课 · Tool Schema](../s02_tool_schema/) 会把可执行 Handler 放进 Registry，只向模型暴露 Schema。
