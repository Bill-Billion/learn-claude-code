# s13 的 Pi 0.79.1 源码对照

s13 对应的不是一个独立 Class，而是 Pi 的 Assembly Path：Trust、Resource、Package、Extension、Agent Harness、Session 与 Shell 在第一个 Prompt 前汇合。

```text
resolve trust and resources
  -> build Agent Session services
  -> run one Agent Harness over one Session
  -> expose CLI modes and SDK methods
```

## 对应文件

- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/modes/print-mode.ts)

## 对应关系

| s13 | Pi 0.79.1 |
| --- | --- |
| `createIntegratedHarnessRuntime()` | `createAgentSession()` 与 `createAgentSessionRuntime()` 执行的 Assembly |
| 传入的 Model、Tool Registry 与 Session | Agent Session Service 与 `AgentHarness` Dependency |
| `prepareProjectTrust()` | Final Resource Loading 前的 `resolveProjectTrusted()` |
| `createPackageRuntime()` | Package Manager Selection 加 `ResourceLoader.reload()` |
| `extensionFactories` | Pi Module Loader 解析 Path 后的 Extension Factory |
| `MiniCoreRuntime` | Agent Harness 与 Agent Session State 上的教学 Facade |
| `promptTemplates` / `invokePromptTemplate()` | 已加载 Template 与显式 `expandPromptTemplate()` Invocation |
| `IntegratedHarnessRuntime` | 带课程 Prompt Queue 的 Host-facing Session Facade |
| Print、JSON、RPC 与 SDK Helper | 同一 Runtime 周围的 CLI Mode 与 Direct Agent Session API |

## Assembly 顺序

Pi 的 `createAgentSession()` 会组合 Settings、Model Selection、Session Manager、Package Manager、Resource Loader、Extension、Tool 与 `AgentSession`。CLI 的 `AgentSessionRuntime` 保留替换或 Reload Session 所需的 Service，同时让 Mode-level Ownership 位于 Agent Loop 之外。

s13 显式展示同样的 Dependency Order：

```text
Project Trust
  -> protected direct paths and project packages
  -> package Resource selection
  -> Extension factories, Skills, Prompt Templates
  -> MiniCoreRuntime and AgentMessage Session
  -> IntegratedHarnessRuntime and shells
```

真实 Model 与 Tool Registry 只提供一次。所有 Shell 都委托最终 Runtime，不会再构造一套 Loop。

## Trust、Resource 与 Package

Pi 的 `ResourceLoader.reload()` 会执行 Pre-trust Pass、解析 Project Trust、更新 `SettingsManager.projectTrusted`、解析 Package 与 Direct Resource Path，最后加载完整 Extension Set 与其他 Resource。

课程保留可观察边界：

- Context Candidate 不受 Project Trust 影响；
- User Resource 与 User Package 保持可用；
- Project Skill、Prompt Template、Direct Extension 与 Project Package 只在 Trust 后参与；
- Package/Direct Extension Path 必须匹配显式课程 Factory；
- Selected Prompt Template 在显式调用前只是一份 Catalog Data。

Pi 会动态加载 Extension Module，并从 Settings 取得 Package List。s13 把二者作为 Host Argument 接收。显式 Map 将 Eligibility 与 Execution 分开，适合教学，但不是 Pi 的 Module-loading API。

## 一份 AgentMessage Session 与全部 Shell

`AgentHarness` 从 Session Context、System Prompt、Tool 与 Hook 构造每个 Turn，再把 Rich Agent Message 追加回 Session。s13 复用课程对这些 Contract 的真实实现；Tool Call 与 Tool Result 始终是结构化 `AgentMessage`。

`IntegratedHarnessRuntime` 实现 `prompt()`、`getState()` 与 Live `subscribe()`，因此 Print、JSON、RPC 与 SDK Access 共享一个累计 Session。显式 Prompt Invocation 与普通 Prompt 进入同一 Queue 和 Session。

课程会透明地串行化 Concurrent `prompt()` 与 `invokePromptTemplate()` Call。Pi `AgentSession.prompt()` 则要求 Active-stream Caller 选择 `steer` 或 `followUp` Behavior。不要从 Pi Public Concurrency Contract 推导出课程 Queue。

## 课程 Host Policy

s13 要求 Host 提供 Model、Tool Registry、Resource Source、Package Entry 与 Extension Factory。Pi 会从 User/Project Settings 中发现并构造更多 Dependency。

课程还省略 Dynamic Module Loading、Package Installation、Theme UI、Runtime Replacement、Reload、Resume、Compaction Orchestration、Steering、Follow-up Queue、Abort Control、Model Switching 与 Terminal Editor。这些省略不会改变测试证明的 Core Composition。

`PI_PROJECT_TRUST` 会改变课程 CLI 的 Default Policy，但这个小型 CLI 没有 Interactive Trust Selector 或 Persistent Store。因此默认 `ask` 在需要 Decision 时会让 Protected Input 保持关闭。这是 Host Limitation，不是另一套 Project Trust Rule。

## 建议读法

1. 从 `sdk.ts` 的 `createAgentSession()` 与 `createAgentSessionRuntime()` 开始。
2. 跟踪 `ResourceLoader.reload()` 中的 Trust、Package Resolution 与 Final Extension Loading。
3. 阅读 `AgentHarness.createTurnState()` 及其 Loop Handoff。
4. 沿 `AgentSession.prompt()` 查看 Prompt Template Expansion 与 `before_agent_start`。
5. 阅读 Harness Session 中的 Rich-message Append Path。
6. 最后查看 Print Mode 与 `AgentSession.subscribe()`，理解两个 Shell 如何围绕同一个 Assembled Session。
