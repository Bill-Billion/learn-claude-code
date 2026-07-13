# s10 的 Pi 源码对照

s10 对应 Pi 的运行模式层。

```text
create AgentSessionRuntime
  -> app mode dispatch
  -> interactive / print / json / rpc / sdk
  -> same AgentSession and event stream
```

## 对应文件

- [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/main.ts)
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/print-mode.ts)
- [`packages/coding-agent/src/modes/rpc/rpc-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`packages/coding-agent/docs/json.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/json.md)
- [`packages/coding-agent/docs/rpc.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/rpc.md)
- [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/sdk.md)

具体锚点：

```text
README.md:20-24                  Pi 的定位和四种运行模式
README.md:536-539                CLI mode 表
main.ts:98-109                   resolveAppMode()
main.ts:577-705                  createRuntime 并创建 AgentSessionRuntime
main.ts:767-804                  appMode 分发到 rpc / interactive / print-json
agent-session-runtime.ts:67-74   AgentSessionRuntime 持有当前 session 和 cwd-bound services
agent-session-runtime.ts:400-424 createAgentSessionRuntime()
print-mode.ts:32-45              runPrintMode() 接收 AgentSessionRuntime
print-mode.ts:71-108             print/json mode 重新绑定 session 并订阅事件
print-mode.ts:111-127            调用 session.prompt()
print-mode.ts:129-145            text mode 输出最后 assistant 文本
rpc-mode.ts:312-360              RPC mode 绑定 extension UI context 并订阅 session events
rpc-mode.ts:390-411              prompt command 调用 session.prompt()
rpc-mode.ts:442-457              get_state 从同一个 session 取状态
sdk.ts:166-184                   createAgentSession() 创建 session 所需的基础对象
docs/sdk.md:16-38                SDK quick start：subscribe + prompt
docs/sdk.md:70-118               AgentSession API 形状
```

## 对应关系

| s10 | Pi |
| --- | --- |
| `MiniCoreRuntime` | `AgentSession` + `AgentSessionRuntime` 的最小合体 |
| `MiniCoreRuntime.prompt()` | `AgentSession.prompt()` |
| `MiniRuntimeEvent` | `AgentSessionEvent` / `AgentEvent` |
| `runPrintMode()` | `modes/print-mode.ts` 的 text 分支 |
| `runJsonMode()` | `modes/print-mode.ts` 的 json 分支 |
| `runRpcMode()` | `modes/rpc/rpc-mode.ts` |
| `createSdkSession()` | `createAgentSession()` 后直接使用 `session` |
| `runInteractiveMode()` | `InteractiveMode.run()` 的极简影子 |

## 本节采用的简化

真实 Pi 的 runtime modes 多了很多工程细节：

```text
真实 stdin/stdout JSONL framing
TUI editor 和快捷键
extension UI context
session replacement 后重新订阅事件
stdout backpressure
signal cleanup
model / thinking level / scoped model 控制
steer、follow_up、abort、fork、switch_session 等 RPC 命令
RPC prompt accepted response 与后续事件流分离
```

s10 没有实现这些。它只保留一个不变量：

```text
mode shell 不拥有独立 agent 状态
```

事件词表也做了简化：mini 用 `session / agent_start / message / agent_end` 四种事件。其中 `message` 在 Pi 里并不存在（Pi 是 `message_start / message_update / message_end`），`session` 对应的是 JSON mode 先写出的 session header（`print-mode.ts:112-117`），不是事件。s13 会把这些外壳接回 s04/s05 那套真正的事件流。

只要这个不变量成立，外壳就可以增减。print 可以短，interactive 可以复杂，RPC 可以机器友好，SDK 可以嵌入应用。它们共享的是同一份 session/runtime。

## 和前几节的关系

```text
s03 Provider Events      JSON mode 输出事件
s06 Turn State           runtime 一轮 prompt 时使用同一份状态快照
s07 Session Tree         runtime 负责当前 session 的延续和切换
s08 Context Resources    runtime 创建时加载 cwd 相关资源
s09 Extension Runtime    每种 mode 都要按自己的 UI 能力绑定 extension
```

这也是 Pi 的一个重要设计点：外壳可以不同，核心状态和事件协议尽量一致。

## 建议读法

先看 `main.ts` 的 `resolveAppMode()` 和最终分发逻辑。这里能看到 CLI 参数只决定入口形态，不决定另起一套 agent。

再看 `print-mode.ts`。text 和 JSON 在同一个函数里，差别主要是 text 取最后回答，JSON 订阅事件并逐行输出。

最后看 `rpc-mode.ts` 和 `docs/sdk.md`。RPC 适合非 Node 进程或跨进程集成，SDK 适合 TypeScript 程序直接嵌入。两者目的接近，边界不同。
