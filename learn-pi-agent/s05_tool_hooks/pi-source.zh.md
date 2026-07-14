# s05 的 Pi 0.79.1 源码对照

s05 对应 `pi-agent-core` 中的 Tool Hook 边界。

```text
tool_execution_start
  -> beforeToolCall
  -> execute Tool
  -> afterToolCall
  -> tool_execution_end
  -> Tool Result Message
```

## 对应文件

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md)

## 对应关系

| s05 | Pi 0.79.1 |
| --- | --- |
| `ToolHooks.beforeToolCall` | `AgentLoopConfig.beforeToolCall` |
| `{ block: true, reason }` | Pi `BeforeToolCallResult` 的阻止路径 |
| `BeforeToolCallResult.arguments` | 课程为了展示参数改写而增加的字段 |
| `ToolHooks.afterToolCall` | `AgentLoopConfig.afterToolCall` |
| `{ content, isError, terminate }` | Result Finalization 的教学版子集 |
| `createHookExecutor()` | 包围 Pi 准备与收尾边界的 Policy |
| `runHookedToolLoop({ ... })` | Pi `runAgentLoop()` 中带 Hook 的路径 |
| `RunEventedToolLoopResult.terminated` | Tool Result 请求终止产生的提前停止效果 |
| 所有 Outcome 都要求终止 | Pi 的混合批次规则：Mixed Batch 正常继续 |

Pi 会把完整 `AgentContext` 交给 Hook，而课程暴露当前 Message List。Pi 的 After Hook 处理尚未包装成 Message 的 Agent Tool Result；课程则传入 `ToolResultMessage`，再应用一个更小的 Patch。

## Hook 顺序与职责

双方共享的关键顺序是：

```text
validate and prepare call
beforeToolCall
  blocked -> error result, skip Handler
  allowed -> execute Handler
afterToolCall
final Tool Result
```

Hook 层不拥有 Message 顺序与生命周期发出过程。这些职责仍然属于 s04 重建的 Agent Loop，因此 Policy 可以组合在执行周围。

## 课程实现的差异

`BeforeToolCallResult.arguments` 是课程特意增加的字段。它会在 `executeDefault()` 前构造 Effective Tool Call，让参数改写保持可观察。不要把它理解成从 Pi 0.79.1 `BeforeToolCallResult` 复制来的字段。

课程也省略了更完整的 Result Details、`AbortSignal`、Tool Progress、并行执行、Permission UI 和 Project Trust。产品可以用 Hook 实现权限或审计 Policy，但这些产品界面不是 Agent Core Hook 自带的机制。

Before Hook 阻止调用时，课程会创建 Error Tool Result，不再调用 After Hook。如果课程的 After Hook 在执行后抛错，已产生的 Content 会被保留，Result 会追加 Post-Hook Failure Note 并把 `isError` 设为 true；Loop 会继续，但绝不会重试 Handler。这种保留是课程特意选择的 Recovery 行为。Pi 0.79.1 与之不同：`finalizeExecutedToolCall()` 会用只包含 After Hook Failure 的新 Error Result 替换已执行 Result，而不是保留原始 Content。After Hook 为一批调用请求终止时，只有每个 Tool Outcome 都提出请求，s04 才会在下一次 Provider Turn 前结束。

## 建议读法

1. 先看 [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts) 中的 `BeforeToolCallResult`、`AfterToolCallResult` 和 Context Type。
2. 阅读 [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md) 中的 Hook 顺序和 Mixed Batch 终止说明。
3. 沿 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) 的 Tool Call Preparation，观察被阻止的调用如何变成 Error Result。
4. 再追踪 Result Finalization，观察 After Hook Patch 与 `terminate` 如何在 Tool Result Message 发出前生效。
