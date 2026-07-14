# 第 13 课 · Integrated Harness

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：解析 Trust 与 Resource、构造一个 Agent Session Runtime，再通过 CLI 与 SDK Shell 暴露它的 Assembly Layer。

```text
files + trust policy + package entries + Extension factories
  -> Project Trust
  -> direct Resources + Package Resolver
  -> Extension runner + Skills + Prompt Templates
  -> one MiniCoreRuntime
       +-> real Model and Tool loop
       +-> one AgentMessage Session
  -> serialized IntegratedHarnessRuntime
  -> Print / JSON / RPC / SDK
```

## 先搞懂：零件分别正确，不代表组合顺序正确

前面的每一课都单独证明了一条边界。Integrated Harness 必须按正确顺序组合它们。

Trust 必须先于 Project Extension 与 Package Selection；Package Path 必须先于 Extension Factory Loading；Context、Skill 与显式调用的 Prompt Template 必须和 Tool Registry 进入同一个 Turn；所有 Shell 必须共享一份 AgentMessage Session；两个调用方不能同时修改这份 Session。

若 Assembly Layer 重新实现了其中任何一部分，课程最后就会出现第二套不兼容的 Agent。因此 s13 只增加 Orchestration 与一条 Concurrency Rule，不增加新的 Model-Tool Loop。

## 思路：让 Host 依赖通过一个构造入口汇合

`createIntegratedHarnessRuntime()` 接收 Host 拥有的 Dependency 与 Configuration，再连接 s01-s12 的公开 API：

| Host Input | 进入哪里 |
| --- | --- |
| `Model<Api>` 与 Stream Option | 真实 s03-s06 Model Path |
| Tool Registry 与 Active Tool Name | 真实 Tool Loop |
| `MiniSession<AgentMessage>` | 一份累计 Session Tree |
| Resource Source 与 Direct Path | Context、Skill 与 Prompt Template |
| User/Project Package Entry | s12 Package Resolver |
| Path-to-Factory Map | Direct 与 Packaged Extension |
| Trust Policy 与 Store | s11 Project Trust |

Result 是 `IntegratedHarnessRuntime`。它实现 s10 `MiniRuntime` Contract，暴露 `projectTrusted`、`projectInputs` 与 `packageResources` 供检查，并保留显式 Prompt Template Invocation。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s13 -- "使用 read_file 检查 package.json，再说明哪些组件共享 Integrated Session。"
```

CLI 使用已配置的真实 Model、Filesystem Context Resource Source、Session Tree、`read_file` Tool 与 Print Shell。Model Output 与 Tool Choice 可能变化；所有这些行为都经过 `createIntegratedHarnessRuntime()` 构造的同一条 Integrated Path。

`PI_PROJECT_TRUST` 默认为 `ask`。这个精简 CLI 没有 Trust Selection UI 或持久化 Store，因此需要 Decision 时，受保护的 Project Input 会保持关闭。审查项目后，`always` 可启用它们，`never` 会拒绝它们：

```bash
PI_PROJECT_TRUST=always npm run s13 -- "总结受信任的项目 Resource。"
```

课程 Host 不会动态 import TypeScript，也不会把 Project Settings 解析成 Package Entry。Trusted Direct Extension 必须由 Programmatic API 提供显式 Factory，否则构造会失败。因此，只有当选中的 Project Input 不依赖尚未配置的 Extension Factory 时，内置 CLI 才适合直接启用 Trust。

## 代码怎么写的

### 1. 在选择 Project Input 前解析 Trust

`createIntegratedHarnessRuntime()` 从 `prepareProjectTrust()` 开始。Decision 控制三类受保护 Source：

- s11 发现的 Direct Project Skill 与 Prompt Template；
- `.pi/extensions` 下的 Direct Project Extension Entry Point；
- Host 传入的整个 `projectPackages` List。

User Extension、Skill、Prompt 与 Package Input 不受 Project Trust 影响。Context Candidate File 也始终位于 Trust Gate 之外，使用 s08 与 s11 的 Per-directory Precedence。

Decision 可从 `runtime.projectTrusted` 读取，准确的 Gated Path 则被克隆到 `runtime.projectInputs`。

### 2. 用显式 Extension Factory 合并 Resource Path

Trusted Direct Project Extension Directory 会经过 s12 Entry-point Discovery，因此 Child `index.ts` 可以加载，而 `helper.ts` 不会被当成第二个 Extension。

`extensionFactories` 是规范化的 Path-to-Factory Map，同时为 Direct Extension 与 Package 选中的 Extension Path 提供 Factory。Selected Path 缺失 Factory 时会报错；Harness 不会把 String Path 解释成执行 Source Code 的许可。

`createPackageRuntime()` 会合并 User Path、Trusted Project Path 与 Enabled Package Path。Extension Factory 进入 Runner，Skill 进入 Context Resource，Prompt File 进入 Template Catalog。普通 Turn 的 System Prompt 不包含 Template Body；`runtime.invokePromptTemplate(name, args)` 只展开一个选中的 Template，并把展开后的 User Prompt 排入真实 Turn。

### 3. 保持一个真实 Model 与 AgentMessage Session

组合后的 Core 仍然是 `MiniCoreRuntime`。它调用真实 `runExtensionTurn()` Path：构造 Context Resource，运行 `before_agent_start` 与 Tool Hook，流式调用传入的 Model，分发 Tool，发出 Lifecycle Event，再把完整 `AgentMessage` 追加到传入的 Session。

若 Host 没有提供 `session`，s13 会创建 Session Tree。若 Host 显式传入 Session，每个使用 Tool 的 Turn 都会按以下顺序追加完整 Message：

```text
user
assistant(toolCall)
toolResult
assistant(final text)
```

Context Instruction、Package Skill Metadata、显式 Prompt Invocation、Extension 注册的 Tool 与 Base Tool 都影响同一份 Session。没有 Adapter 把 Rich Message 压平成 Plain Text。

### 4. 串行化 Host Prompt，再复用全部 Shell

`IntegratedHarnessRuntime.prompt()` 通过 `promptQueue` 链接 Work。Concurrent Call 会按提交顺序执行，因此两个 Run 都能稳定地读取并更新同一 Session。无论成功还是失败，Queue 都会继续结算，单个 Rejected Run 不会阻塞后续 Work。显式 Prompt Template Invocation 也使用同一 Queue。

`getState()` 与 `subscribe()` 会委托给 Core，因此无需 Translation 就能复用现有 s10 Helper：

| Shell | Integrated Behavior |
| --- | --- |
| Print | 等待一次 Final Text Result |
| JSON | Run 结束后序列化已捕获 Event |
| RPC | 在同一个 Runtime 上支持 `prompt` 与 `get_state` |
| SDK | Queued Turn 运行期间实时接收 Event |

## 动手试一试

1. 组合一个带 Extension Tool、Skill 与 Prompt Template 的 User Package。确认普通 Turn 能看到 Tool 与 Skill，但看不到 Prompt Body。
2. 调用 `invokePromptTemplate()` 并检查最后一条 User Message。展开文本应进入一个真实 Queued Turn。
3. 同时加入 User 与 Project Package，再拒绝 Trust。User Resource 应保留，Project Package 与 Direct Project Extension 应消失。
4. 在 Trusted Direct Extension Directory 中加入 `index.ts` 与 `helper.ts`，只为 Entry Point 提供 Factory，确认只有该 Factory 加载。
5. 依次调用 Print、JSON、RPC 与 SDK。`getState().turns` 与 Session Message List 应包含全部四次调用。
6. 用 `Promise.all()` 同时启动两次 `prompt()`。Run ID 与 Session Message 应保持提交顺序。

## 接入课程主线

| 边界 | 前面课程 | s13 的组合 |
| --- | --- | --- |
| Model 与 Tool Loop | s01-s05 | 一次带 Hook 与 Event 的真实 Streamed Turn |
| AgentMessage State | s06-s07 | 一份累计 Session Tree |
| Context 与 Resource | s08 | Context Candidate、Skill、显式 Prompt Invocation |
| Extension | s09 | Direct 与 Package-selected 显式 Factory |
| Runtime Shell | s10 | 一套 Shared Print/JSON/RPC/SDK Surface |
| Project Trust | s11 | 在 Protected Path 参与前解析 |
| Package | s12 | Enabled Path 进入同一个 Core |
| Host Concurrency | 前面没有 Owner | Shared Session 外的一条有序 Promise Queue |

## 对照 Pi 源码

Pi 0.79.1 通过 `createAgentSession()`、`AgentSessionRuntime`、`ResourceLoader`、`ProjectTrustStore`、`DefaultPackageManager`、Extension Loader/Runner、`AgentHarness` 与 Session API 完成同类 Assembly。CLI Mode 与 SDK Call 都是该 Session 周围的 Shell。

课程把组合保持为可见、可注入的代码。它接收已经创建好的 Model、Tool Registry、File Source、Package Entry 与 Extension Factory。Pi 还负责 Settings Parsing、Model Discovery、Extension Module Loading、Package Installation、UI Service、Reload、Compaction 与更完整的 Session Control。

透明 Promise Queue 是课程 Host Policy。Pi 不会在 Streaming 期间静默地把第二次 `prompt()` 串行化；调用方需要选择 Steering 或 Follow-up Behavior。两种设计都在保护 Active Session 的含义，但 Public Concurrency Contract 不同。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 你已经完成了什么

最终 API 不是 Harness 的示意图。它把真实课程 Model Path、Tool Execution、Event、AgentMessage Session、Context Resource、Extension、Trust Gate、Package Resolver、Prompt Template Invocation 与四种 Runtime Shell 放到同一条可运行路径中。

回到[课程首页](../README.zh.md)，复习完整学习路线，再选择一条边界继续扩展。
