# 第 6 课 · Harness Turn State

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：`pi-agent-core` 的 `AgentMessage` 边界、`AgentHarness.createTurnState()`，以及转换为模型侧 `Message[]` 的过程。

```text
session AgentMessage[] -> TurnState 快照 -> transformContext -> convertToLlm -> 模型
                                      |
                                      +-> 真实 Tool Loop -> 持久化每条已完成 Message
```

## 先搞懂：为什么既需要丰富历史，也需要稳定 Turn

到 s05 为止，Loop 已经可以调用真实模型、执行 `read_file` 并应用 Tool Hook。不过，它的输入仍然分散，历史也只包含模型能理解的 Message。

Coding Agent 需要更丰富的内部记录：Shell 执行、Extension Message、Branch Summary 和 Compaction Summary。把这些记录原样发给 Provider 会破坏 Provider 的 `Message` 契约。若在多步 Turn 中持续读取可变配置，又会出现另一个问题：第二次 Provider Call 可能使用与第一次不同的 Model、Tool Set 或 Prompt。

## 思路：分开 AgentMessage、TurnState 与模型 Context

s06 引入两条边界：

```text
AgentMessage = pi-ai Message
             | BashExecutionMessage
             | CustomMessage
             | BranchSummaryMessage
             | CompactionSummaryMessage

TurnState = messages + resources + streamOptions + sessionId
          + systemPrompt + model + tools + activeTools
```

Session 保存 `AgentMessage[]`。Turn 开始时，`createTurnState()` 会快照本次 Turn 使用的一切。只有到模型边界，`createLlmContext()` 才会先应用 `transformContext`，再调用 `convertToLlm()`。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s06
```

也可以直接发送一次 Prompt：

```bash
npm run s06 -- "使用 read_file 检查 package.json，并报告 pi-ai 版本。"
```

这条命令运行的仍是前几课同一条真实 Model-Tool-Model 路径。回答措辞和具体 Tool Call 可能变化；稳定行为是 Prompt、Assistant Message 和 Tool Result 会随着 Turn 推进逐条追加到 Session。

## 代码怎么写的

### 1. 分开内部 Message 与模型侧 Message

`AgentMessage` 在官方 `pi-ai` `Message` 联合类型上增加四种 Harness 内部 Role。`cloneAgentMessage()` 会深拷贝任意成员，避免 Session History 和 Turn Snapshot 共享可变内容。

它不是第二套 Provider Protocol，而是 Harness 的存储协议。

### 2. 为一次 Turn 建立快照

`createMiniHarness()` 捕获已注册 Tool Definition、选中的 Active Tool Name、Resource、Stream Option 和 System Prompt 定义。`createTurnState()` 再读取当前 Session Context 与 Metadata，解析动态 System Prompt，并返回独立副本：

```ts
const turnState = await createMiniHarness(options).createTurnState();

turnState.messages;
turnState.model;
turnState.tools;
turnState.activeTools;
turnState.resources;
turnState.streamOptions;
```

`tools` 是全部注册项；`activeTools` 是本次 Turn 向模型暴露、也允许执行的子集。

### 3. 只在模型边界做转换

`createLlmContext()` 保证以下顺序：

```ts
const transformed = transformContext
  ? await transformContext(agentMessages)
  : agentMessages;

const messages = convertToLlm(transformed);
```

标准 User、Assistant 和 Tool Result Message 会直接通过。Bash、Custom、Branch Summary 与 Compaction Summary 记录会转成模型可读的 User Message；标记了 `excludeFromContext` 的 Bash 记录会被省略。Session 中的丰富值不会被改写。

### 4. 运行并逐条持久化真实 Turn

`runHarnessTurn()` 创建快照与模型 Context，选择 Active Registry，追加新的 User Message，再交给 s05 的 `runHookedToolLoop()`。它的 `message_end` Listener 会为每条已完成的 Assistant 或 Tool Result Message 等待 `session.appendMessage()` 完成。

这个顺序很重要。即使某次 Tool 执行后的后续 Provider Call 失败，更早的 Assistant Message 与 Tool Result 也已经进入 Session。Harness 不会等整个 Turn 全部成功才保存历史。

## 动手试一试

1. 向 `createMemorySession()` 加入一条 `CustomMessage`，调用 `createLlmContext()`，观察它如何变成 User Message，而存储值不变。
2. 设置 `activeToolNames: []` 后让模型读文件，对比模型侧 Tool List 与完整的 `turnState.tools`。
3. 加入一个会追加 Context Note 的 `transformContext`，确认它进入模型 Context，但不会自动写回 Session。

## 接入课程主线

| 边界 | s05 | s06 |
| --- | --- | --- |
| 历史类型 | 模型侧 `Message[]` | Session 中丰富的 `AgentMessage[]` |
| Turn 输入 | 分散的 Loop 参数 | 一份 `TurnState` 快照 |
| 模型边界 | Message 已是模型形状 | 先 `transformContext`，再 `convertToLlm` |
| Tool 暴露 | Registry 交给 Loop | 全部 Tool 加每 Turn Active Tool |
| 持久化 | Loop 结束后返回 | Loop 中逐条追加已完成 Message |
| Provider 路径 | 真实 Model 与 Tool Loop | 经 `runHarnessTurn()` 的同一条真实路径 |

## 对照 Pi 源码

`AgentMessage` Role、转换顺序和 Turn Snapshot 都对应 Pi 0.79.1。课程做了更积极的深拷贝，并省略 `thinkingLevel`、Queue 和 Provider Request Hook 等字段。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 7 课 · Session Tree](../s07_session_tree/) 会用 Append-only JSONL Entry、Branch 和 Summary Entry 替换内存 Message List，并把它们重新物化为 `AgentMessage[]`。
