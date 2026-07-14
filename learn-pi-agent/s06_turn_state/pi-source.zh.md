# s06 的 Pi 0.79.1 源码对照

s06 把 Pi 的 `AgentMessage` 边界与 Harness Turn Snapshot 接到一起。

```text
Session.buildContext()
  -> AgentHarnessTurnState
  -> transformContext(AgentMessage[])
  -> convertToLlm(Message[])
  -> provider
```

## 对应文件

- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/messages.ts)

## 对应关系

| s06 | Pi 0.79.1 |
| --- | --- |
| `AgentMessage` | Core `AgentMessage` 加 Coding Agent 的 Custom Message 扩展 |
| 四种 Harness 内部 Message Role | `BashExecutionMessage`、`CustomMessage`、`BranchSummaryMessage`、`CompactionSummaryMessage` |
| `convertToLlm()` | Coding Agent 的 `convertToLlm()` |
| `TransformContext` | `AgentLoopConfig.transformContext` |
| `createMiniHarness().createTurnState()` | `AgentHarness.createTurnState()` |
| `TurnState.activeTools` | 复制进 `AgentContext.tools` 的 Active Tool |
| `runHarnessTurn()` | 把 Harness State 接入 Core Agent Loop |

Pi 的 `streamAssistantResponse()` 会先对 `AgentMessage[]` 应用 `transformContext`，再调用 `convertToLlm()`，然后才构造 Provider `Context`。课程保留了这条边界。

## Message 转换

Pi 的 Coding Agent `messages.ts` 定义了本课重建的四种额外 Role。标准 User、Assistant 和 Tool Result Message 会直接通过；Bash 与 Custom 记录会变成 User Message；Branch 或 Compaction Summary 会变成带前缀的 User Message。

课程保持相同的语义分层，但使用更短的 Summary Wrapper，同时深拷贝转换值，让教学版 Snapshot 更容易验证。

## Turn Snapshot 与持久化

Pi 的 `AgentHarnessTurnState` 包含 Message、Resource、Stream Option、Session ID、System Prompt、Model、Tool、Active Tool 和 `thinkingLevel`。s06 的 Snapshot Shape 只省略了其中的 `thinkingLevel`。

`runHarnessTurn()` 是课程组合代码，不是照抄的 Pi 函数。它把 Snapshot 接到 s05 Loop，并通过 Session Sink 持久化每个 `message_end` 值。双方共享的重要职责划分是：Harness 准备 State，Agent Loop 管理 Model 与 Tool 的推进。

## 课程范围

s06 有意省略 Steering 与 Follow-up Queue、Abort Handling、Provider Request Hook、API Key 刷新、Retry Policy 和自动 Compaction。它没有用脚本响应替代 Provider：课程 CLI 仍会加载真实 `pi-ai` Model，并可通过 `read_file` Tool Result 继续运行。

## 建议读法

1. 先看 Coding Agent `messages.ts` 中的 Custom Message 声明与 `convertToLlm()`。
2. 再看 `agent-loop.ts` 的 `streamAssistantResponse()`，确认转换顺序。
3. 阅读 `agent-harness.ts` 中的 `AgentHarnessTurnState`、`createTurnState()` 与 `createContext()`。
4. 最后与本课的 `AgentMessage`、`createLlmContext()` 和 `runHarnessTurn()` 对照。
