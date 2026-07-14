# s10 的 Pi 0.79.1 源码对照

s10 把四种访问 Shell 接到同一个累计 Agent Session Runtime。

```text
AgentSessionRuntime
  -> Interactive
  -> Print: text or JSON
  -> RPC
  -> SDK AgentSession API
```

## 对应文件

- [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/main.ts)
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)
- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/print-mode.ts)
- [`packages/coding-agent/src/modes/rpc/rpc-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`packages/coding-agent/docs/json.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/json.md)
- [`packages/coding-agent/docs/rpc.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/rpc.md)
- [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/sdk.md)

## 对应关系

| s10 | Pi 0.79.1 |
| --- | --- |
| `MiniCoreRuntime` | Shared Agent Session Runtime 的教学 Facade |
| 一份外部提供的 Session | `AgentSessionRuntime` 持有的 Current Session |
| Async `createMiniCoreRuntime()` | 从既有 Metadata 与 Context 构造 Session Host |
| 单调 `promptCount` | 不随 Active Context 缩短的课程 Attempt State |
| `getPrompts()` / `getRuns()` | 本 Host 提交的 Attempt / 成功 Result Snapshot |
| `runInteractiveMode()` | `InteractiveMode` |
| `runPrintMode()` | `runPrintMode()` 的 Text 分支 |
| `runJsonMode()` | `runPrintMode()` 的 JSON 分支 |
| `runRpcMode()` | RPC Mode 的 Command/Response Core |
| `createSdkSession()` | `createAgentSession()` 创建的直接 Agent Session API |
| `MiniRuntime.getState()` | 向 Shell 暴露的教学版 Session State 子集 |
| `MiniRuntime.subscribe()` | Live Agent Session Event Subscription |
| 捕获的 `AgentEvent[]` | 既有 Event Protocol 的 Per-run Snapshot |

## 同一个 Runtime 与 Session

Pi 的 `main.ts` 会在解析 App Mode 后，使用同一组 Service 与 Runtime Factory 构造 Current Agent Session。Interactive、Print/JSON 与 RPC 接收 Shared Runtime Host，而不会各自创建 Agent Loop。

SDK 是 Programmatic Entry：`createAgentSession()` 在没有 CLI Presentation Layer 的情况下构造同类 Model、Session Manager、Resource Loader、Tool 与 Extension。s10 把四种访问方式放到一个小型 `MiniRuntime` Interface 后，直接验证它们共享 State。

课程 Factory 会先读取 Session Metadata 与 Active Context，因此 Resumed Message 在 Prompt 前就可见。`turns` 是教学 Host 的单调 Prompt-attempt Count，并根据已有 User Message 初始化。即使 Branch Navigation 或 Compaction 让 Active Context 变短，Run ID 仍使用该 Counter。失败 Attempt 会留在 `getPrompts()`，但只有产生 Result 才会进入 `getRuns()`。

## Shell 行为

Pi 的 Print Mode 有两种输出分支。Text 在 Prompt 后读取 Final Assistant Message；JSON 会订阅 Session，再写出 Session Header 与 Event。RPC 订阅同一 Session，并把 `prompt`、`get_state` 等 JSON Command 转换为操作。

课程把 Print Text 与 JSON 暴露为两个 Helper，RPC Command Table 只保留 `prompt` 与 `get_state`。Interactive 返回 Transcript，不实现 Pi 的 Terminal UI。SDK Wrapper 会把 `subscribe()` 委托给 Core，因此 Callback 会在 `prompt()` 仍在运行时收到 Event。

课程 RPC 会等待完整 Prompt。Rejection 会变成可关联的 `success: false` Response；在此之前，Core 会尝试刷新失败 Turn 已经持久化的 Session Message。Pi RPC 则在 Preflight 后发出权威 Prompt Response，让 Session Event 独立继续。

## Event Timing 差异

两个面向机器的 Helper 仍保留了更简单的 Timing：

```text
course JSON: await prompt -> serialize captured Events
course SDK:  subscribe -> receive live Events while prompt runs
course RPC:  await prompt -> return full Run result or failure response
```

课程 SDK 现在与 Pi 的 Live Agent Session Subscription 一致。课程 JSON Helper 仍会在完成后序列化，而 Pi 的 Print JSON 分支会在 Prompt 前订阅。课程 RPC `prompt` 会等待完整 Run Result 或捕获 Rejection；Pi RPC 在 Prompt Preflight 成功后确认 Command，而 Session Event 会独立继续。

## 课程范围

真实 Runtime 还支持 Session Replacement、Resume、Fork、Tree Navigation、Steering、Follow-up、Abort、Model 与 Thinking-level Change、Extension UI Binding、Signal Handling、Output Backpressure，以及更多 RPC Command。

s10 保留真实的 s09 Model-Tool Path 与 Session Persistence，但把 Presentation 缩小为四类 Shell 和一个小型累计 State Object。Prompt-attempt Counter 与 Successful-only Run Snapshot 是课程 Observability Field，不是 Pi 完整 Session State Model 的复制。它没有引入第二套 Agent Core。

## 建议读法

1. 先看 `main.ts` 的 `resolveAppMode()` 与最终 Dispatch。
2. 阅读 `runPrintMode()`，对比 Text 与 JSON 分支。
3. 沿 RPC 的 `rebindSession()`、Session Subscription、`prompt` 与 `get_state` 阅读。
4. 查看 `sdk.ts` 的 `createAgentSession()`。
5. 最后与 `MiniCoreRuntime` 和课程四类 Shell 对照。
