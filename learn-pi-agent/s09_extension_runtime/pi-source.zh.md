# s09 的 Pi 0.79.1 源码对照

s09 对应 Pi 的 Extension 加载、Registration API、Event Runner 与 Agent Session 集成。

```text
Extension factory -> Extension record -> ExtensionRunner -> Harness boundaries
```

## 对应文件

- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/types.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/extensions.md)

## 对应关系

| s09 | Pi 0.79.1 |
| --- | --- |
| `MiniExtensionFactory` | `ExtensionFactory` |
| `MiniExtensionAPI` | `ExtensionAPI` 的教学版子集 |
| `LoadedExtension` | `Extension` Registration Record |
| `loadMiniExtensions()` | Factory Loading 加 `createExtensionAPI()` |
| `MiniExtensionRunner` | `ExtensionRunner` |
| `emitBeforeAgentStart()` | `ExtensionRunner.emitBeforeAgentStart()` |
| `emitResourcesDiscover()` | `ExtensionRunner.emitResourcesDiscover()` |
| `emitToolCall()` | `ExtensionRunner.emitToolCall()` |
| `createExtensionToolHooks()` | Agent Session 把 `tool_call` 接到 `beforeToolCall` 的 Wiring |
| `mergeExtensionTools()` | Registered Tool 进入 Agent Tool Set |
| `runCommand()` | 精简的 Registered Command 调用界面 |

## Registration 与 Execution

Pi 的 `createExtensionAPI()` 会把 Event Handler、Tool 和 Command 写入当前 Extension Record。Shared Runtime 在初始加载阶段使用不可调用的 Action Stub，从而把 Registration Phase 与 Live Execution 清楚分开。

s09 保留了这条核心规则。课程 Factory 已由调用方提供；Pi 则会动态 Import 文件，并支持同步与异步初始化。

## Event 集成

`before_agent_start` Handler 按加载顺序串联。Pi 会收集它们的 Custom Message 并加入 Agent Input Message；s09 物化同一类 Message Shape，并在建立真实 Turn Snapshot 前通过 Session 持久化。

在 Pi 的 `AgentSession` 中，`tool_call` 会安装为 Agent 的 Before Tool Hook。本课通过 `createExtensionToolHooks()` 明确建立这条连接，因此阻止调用仍会生成正常 Tool Result Lifecycle。课程的 Composition Helper 会先应用调用方的参数改写，再执行 Extension Policy，保证 Policy 检查的就是实际将要执行的值。

两种实现的 `resources_discover` 都会返回带报告 Extension Path 的 Resource Path。即使 Resource Loader 之后合并多个来源，这份 Provenance 仍然存在。

## 与前几课组合

Extension 层不会替换已有边界：

```text
s02 Registry          接收 Extension Tool
s05 Tool Hooks        接收 tool_call Policy
s06 AgentMessage      承载 before_agent_start Custom Message
s08 Resource Loader   接收发现的 Skill 与 Prompt Path
```

`runExtensionTurn()` 负责准备这些输入，再交给同一条真实 Harness 与 Provider 路径。

## 课程范围

Pi 的 Extension API 还支持更多 Event、UI Component、Keyboard Shortcut、CLI Flag、Message Renderer、Provider Registration、Session Action、Reload 与 Stale-context Protection。它的 Loader 会按 Extension 报告错误，而不是采用课程更小的 Fail-fast Check。

s09 不会动态 Import Source File，也不实现 Interactive Slash-command Parser。它证明 Tool 与 Command Registration、三条 Event Path、Provenance、Session Insertion，以及与既有 Loop 的组合。

## 建议读法

1. 先看 `types.ts` 中的 `ExtensionFactory`、`ExtensionAPI` 与 `Extension`。
2. 阅读 `loader.ts` 的 `createExtensionAPI()`，观察 Registration 如何写入 Record。
3. 沿 `runner.ts` 阅读三种对应 Emit Method。
4. 最后进入 `agent-session.ts`，观察 `tool_call` 如何变成 Tool Hook，以及 `before_agent_start` Message 如何加入 Agent Input。
