# 第 9 课 · Extension Runtime

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：Coding Agent 的 Extension Loader 与 Runner，并接入 Tool 注册、Command、Resource Discovery 和 Harness Lifecycle Event。

```text
extension factory -> registrations -> runner
                      |   |   |
                      |   |   +-> before_agent_start / resources_discover / tool_call
                      |   +-----> Commands
                      +---------> Tools -> 真实 Harness Turn
```

## 先搞懂：为什么 Workflow 不该全部进入 Core

到 s08 为止，Harness 已有真实 Model-Tool Loop、Session History 与 Context Resource。若把所有 Workflow 都直接加入 Core，它很快会绑定具体产品：有人需要新 Tool，有人需要 Command，有人需要执行前 Guard，还有人需要额外 Skill。

Core 需要稳定的接入点，让外部 Module 添加行为，却不能拥有第二条 Agent Loop。

## 思路：把注册与执行分开

Extension 是一个接收精简 Registration API 的 Factory：

```ts
pi.registerTool(tool);
pi.registerCommand(name, command);
pi.on("before_agent_start", handler);
pi.on("resources_discover", handler);
pi.on("tool_call", handler);
```

注册与执行彼此分开。加载 Factory 只会记录 Tool、Command 与 Event Handler。`MiniExtensionRunner` 会在对应操作发生时，再按加载顺序调用它们。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s09
```

也可以要求本课内置 Extension 参与：

```bash
npm run s09 -- "使用 note 工具记录 Extension Runtime 已连接，然后确认结果。"
```

这仍是真实 Model Call。模型自己决定是否以及如何使用已注册的 `note` Tool，因此措辞与 Tool Call 可能变化。稳定路径是 Extension Tool 会在 Turn Snapshot 前合并，并与内置 Tool 一样经同一 Registry 和 Tool Loop 执行。

## 代码怎么写的

### 1. 把 Factory 加载成 Registration Record

`loadMiniExtensions()` 会用 `MiniExtensionAPI` 运行每个外部提供的 Factory。API 只负责把注册项推入 `LoadedExtension` Record。多个已加载 Extension 间重复的 Tool 或 Command Name 会被明确拒绝。

`MiniExtensionRunner.getTools()`、`getCommands()` 与 `runCommand()` 操作的是克隆后的 Record。本课接收调用方提供的 Factory，不会动态 Import Extension File。

### 2. 在 Snapshot 前准备 Resource 与 Tool

`resources_discover` Handler 可以返回 Skill、Prompt 与 Theme Path。Runner 会为每个 Path 加上报告它的 `extensionPath`，保留来源。s09 把发现的 Skill 与 Prompt Path 交给 s08 的 Resource Preparation。

`mergeExtensionTools()` 会拒绝与 Base Tool Name 冲突的注册项，再扩展 s02 Registry。两步都发生在 Harness 捕获 Tool 与 Resource Snapshot 之前。

### 3. 持久化 before_agent_start Message

`before_agent_start` Handler 按 Extension 加载顺序运行。每个 Handler 都能看到前一个 Handler 生成的 System Prompt，并可返回修改后的 Prompt 与一条 Custom Message。

Runner 会把该值物化为 s06 的 `CustomMessage` Type。`runExtensionTurn()` 在启动真实 Harness Turn 前把每条 Custom Message 追加进 Session，因此新的 Turn Snapshot 会包含它。到模型边界，s06 的 `convertToLlm()` 会把它转换成模型可读的 User Message。

### 4. 把 tool_call 接到 s05 Hook 边界

`createExtensionToolHooks()` 会把 `tool_call` Event 适配到 s05 的 `beforeToolCall`。在 `runExtensionTurn()` 中，调用方的 Before Hook 先运行；若它改写参数，Extension Policy 会收到这份 Effective Tool Call。任一层阻止时都会产生正常 Error Tool Result，Handler 不会执行；否则改写后的参数继续进入校验与执行。

Extension 注册的 Tool 本身与 Base Tool 共享 Schema Validation、Execution Lifecycle、Result Persistence 与真实 Provider Continuation。任何 Extension 路径都不会绕过主 Loop。

## 动手试一试

1. 在一个 Factory 中注册 `echo` Tool 与 `hello` Command。检查 `runner.getTools()`，再用 `runCommand()` 调用该 Command。
2. 加入返回一个 Skill Path 的 `resources_discover` Handler，确认已加载 Skill 与它的 `extensionPath` 来源。
3. 加入阻止 `read_file` 的 `tool_call` Handler。让模型读文件，确认 Session 得到 Error Tool Result，而不是文件内容。
4. 从 `before_agent_start` 返回 Custom Message，并查看 Turn 前后的 Session Role。

## 接入课程主线

| 边界 | s08 | s09 |
| --- | --- | --- |
| Tool 来源 | Base Registry | Base 加 Extension 注册 Tool |
| Command | 无 | 可通过 Runner 调用的已注册 Handler |
| Resource Path | 调用方参数 | 调用方参数加 Extension Discovery |
| Resource 来源 | 原始 File Path | Path 加报告它的 `extensionPath` |
| System Prompt | Resource Callback | 链式 `before_agent_start` 修改 |
| Tool Policy | 调用方 Hook | `tool_call` 适配到同一 s05 边界 |
| 真实执行 | `runContextResourceTurn()` | 使用同一真实 Loop 的 `runExtensionTurn()` |

## 对照 Pi 源码

Factory Registration、按加载顺序分发 Event、Tool Blocking、Prompt Chaining 与 Resource Provenance 都对应 Pi 0.79.1。Pi 暴露更多 Event 与 UI/Runtime 能力；本课只保留能与 s02、s05、s06、s08 组合的最小子集。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 10 课 · Runtime Modes](../s10_runtime_modes/) 会把同一套 Harness 与 Extension Runtime 放在 Interactive、Print/JSON、RPC 与 SDK Shell 之后。
