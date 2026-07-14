# 第 10 课 · Runtime Modes

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：围绕同一个 Agent Session Runtime 的 Interactive、Print/JSON、RPC 与 SDK Shell。

```text
                         +-> interactive
one MiniCoreRuntime -----+-> print (text or JSON)
one Session              +-> RPC
                         +-> SDK
```

## 先搞懂：为什么不能为每种入口各写一套 Agent

s09 已经有真实 Model-Tool Loop、Session Tree、Context Resource 与 Extension。产品仍需要多种入口：人在 Interactive Terminal 中使用；脚本只要一次结果；其他进程需要 Command；应用程序则需要 API。

若为每种入口分别创建 Agent，Message History 与配置就会分裂。RPC 发出的 Prompt 不会存在于 Interactive Session 中，每次新增 Tool 或 Extension 行为也必须实现多遍。

## 思路：四种 Shell 共享一个 Core 与一个 Session

s10 把四类 Shell 放在同一个 `MiniCoreRuntime` 与同一个 Session 周围：

| Shell | 输入 | 输出 |
| --- | --- | --- |
| Interactive | 一组 Terminal-style Prompt | Transcript |
| Print | 一条 Prompt | 最终文本或 JSONL Lifecycle Event |
| RPC | `prompt` 与 `get_state` Command | 可关联的 Response Object |
| SDK | 直接 Method Call | Result Object、State 与 Event Callback |

Shell Contract 保持精简：

```ts
export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void;
}
```

`createMiniCoreRuntime()` 是 Async Factory，因为它会先 Hydrate Session Metadata 与 Active Message Context。随后 `MiniCoreRuntime.prompt()` 调用 s09 的 `runExtensionTurn()`，捕获并发布真实 Agent Event，刷新 Session Snapshot，再记录成功的 Run Result。所有 Shell 都委托给这个 Object。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s10
```

也可以通过 CLI 的 Print Shell 直接发送一次 Prompt：

```bash
npm run s10 -- "使用 read_file 检查 package.json，并报告 pi-ai 版本。"
```

模型回答与 Tool Call 可能变化。稳定路径与 s09 相同：真实 Model、Extension Turn、Active `read_file` 和 Session Persistence。s10 只改变调用方如何进入 Runtime、如何消费 Result。

## 代码怎么写的

### 1. 把累计 State 留在同一个真实 Core 中

调用方首先需要等待 `createMiniCoreRuntime()`。Factory 会读取 Session Metadata 与 Active Context，因此 Resumed Session 在发送新 Prompt 前，就能报告 Session ID、Message、最新 Assistant Text 与已有 User-Prompt Count。

`MiniCoreRuntime.prompt()` 会先递增单调的 Prompt-attempt Counter，再委托给 `runExtensionTurn()`。它通过 `onEvent` 收集每个 `AgentEvent`，并在 Turn 运行期间把 Event Clone 发送给当前 Subscriber。成功后，它刷新 Session Snapshot，再保存一份克隆后的 `MiniRunResult`：

```ts
const runtime = await createMiniCoreRuntime(options);
const result = await runtime.prompt(prompt);

console.log(result.runId);
console.log(runtime.getState());
```

Turn 失败时，Runtime 仍会刷新 Loop 已经持久化的 Message，再重新抛出原始 Error。`getState().turns` 统计 Prompt Attempt，而不只统计成功 Result；即使 Branch 或 Compaction 让 Active Context 变短，它也不会倒退。`getPrompts()` 包含通过该 Runtime Instance 提交的 Attempt，包括失败项；`getRuns()` 只包含真正产生 `MiniRunResult` 的 Attempt。

### 2. 把 Text 与 JSON 当作两种 Print 输出

`runPrintMode()` 等待 `runtime.prompt()`，再返回 `finalText`。`runJsonMode()` 也会先等待完整 Prompt 完成，然后把捕获的 Lifecycle Event 序列化成 JSONL。

因此，本课 JSON Helper 是 Run 结束后的序列化，不是实时 Event Stream。真实 Pi 的 JSON 分支会在 Prompt 前订阅，并在 Event 到达时立即写出。

### 3. 把 RPC Command 转成同一组 Method Call

`runRpcMode()` 支持 `prompt` 与 `get_state`。它会保留可选 Command ID，让其他进程关联 Response。

教学版 RPC 的 `prompt` Response 会等待 Turn 完成，成功时包含完整 `MiniRunResult`。Model、Tool Loop 或 Event Observer 失败时，`runRpcMode()` 会捕获 Rejection，并用同一关联 Response Shape 返回 `success: false` 与 Error String。真实 Pi Protocol 会把 Preflight Acknowledgement 与异步发出的 Session Event 分开，并支持更多 Command。

### 4. 让 SDK 与 Interactive Wrapper 保持轻薄

`runInteractiveMode()` 按顺序把 Prompt 交给同一个 Runtime，再格式化 Transcript。它不是 TUI；Editor State、Key Binding 和 Rendering 不属于本课。

`createSdkSession()` 通过委托同一个 Core 来暴露 `prompt()`、`getState()` 与 `subscribe()`。`MiniCoreRuntime.subscribe()` 会在底层 Turn 仍在运行时，从 `onEvent` 接收克隆后的 Event，并早于 `prompt()` 完成。它是 Live Subscription，而不是对 `result.events` 的事后回放。Unsubscribe 会让 Listener 不再接收后续 Event。

## 动手试一试

1. 预先向 Session 写入一组 User/Assistant Message，等待 `createMiniCoreRuntime()`，再在发送新 Prompt 前检查 State。
2. 依次调用 Print、JSON、RPC 与 SDK。把单调 `getState().turns`、`getPrompts()` 与只包含成功项的 `getRuns()` 对比。
3. 通过 `createSdkSession()` 订阅，并在 Callback 内检查 `getRuns().length`。Live Event 会在当前成功 Run 存储之前到达。
4. 让一次 RPC Prompt 失败，再发送另一个 Prompt。第一次 Response 应为 `success: false`；刷新后的 Session 应保留已持久化 Message；第二次 Run ID 应使用下一个 Attempt Number。

## 接入课程主线

| 边界 | s09 | s10 |
| --- | --- | --- |
| Core 执行 | `runExtensionTurn()` | 包装为 `MiniCoreRuntime.prompt()` |
| Session | 提供给一次 Turn | 在每次 Shell Call 间共享 |
| Event | 一次 Turn 中的 Callback | 按 Run 捕获，并实时发布给 SDK Subscriber |
| 文本输出 | 调用方读取 Final Message | Print 与 Interactive 负责格式化 |
| 机器输出 | 只有 Result Object | JSONL、RPC Response 或 SDK Object |
| State Hydration | 调用方已经持有 Session | Async Factory 读取 Metadata 与 Active Context |
| Attempt State | 一次一个 Turn | 单调 Attempt 加只含成功项的 Run Result |

## 对照 Pi 源码

Shared Runtime、Session Hydration、Mode Dispatch、Print Text/JSON 分支、RPC Response Layer 与 SDK Session API 都对应 Pi 0.79.1。课程 SDK Subscription 与 Pi Agent Session Subscription 一样会实时接收 Event。课程仍在 Prompt 完成后批量提供 JSON Output，RPC `prompt` 也会等待完整 Run 或返回 Failure Response；Pi 会单独确认 Prompt Preflight，JSON 与 RPC Session Event 则可在工作期间继续传递。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 11 课 · Project Trust](../s11_project_trust/) 会在这些 Runtime Shell 启动前决定哪些项目本地输入可以加载。它是 Loading Gate，不是 Permission System 或 Sandbox。
