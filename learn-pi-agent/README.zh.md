# Learn Pi Agent -- 构建一个小而可扩展的 Agent Harness

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

## 模型负责决策，Harness 让决策能够落地

LLM 提供判断能力：理解当前情况，选择直接回答还是调用工具，查看结果，再决定下一步。Agent Harness 则提供让判断能够运行的条件，包括 Message、Tool、Event、Session State、Extension、信任边界和运行模式。

这门课以 [Pi](https://github.com/earendil-works/pi) 为设计参照，从零重建这些条件。Pi 保持 Kernel 精简，把产品特定的 Workflow 放在 Loop 之外，因此很适合用来观察模型智能在哪里结束、Harness 工程从哪里开始。

```text
模型判断
   |
   v
messages -> provider events -> tool loop -> tool results -> messages
                 |              |
                 v              v
             turn state     hooks / extensions
                  \             /
                   runtime + trust
```

学完 13 节课后，你会得到一个 mini Pi：它包含真实模型工具循环、归一化 Provider Event、带生命周期事件的工具执行、可分支 Session、按需上下文、Extension、信任控制、Package 发现和四种运行模式。第一节课就会调用真实模型，并允许模型使用一个安全的只读工具；后续课程都在发展同一条路径。

这不是 Pi CLI 使用指南，也不是逐行阅读源码的注释版。每节课只拆出一个设计决策，用最小实现让它可见，再映射回固定版本的 Pi 源码。

## 为什么值得重建 Pi

Pi 把 Agent 产品中经常混在一起的三种职责分开：

```text
pi-ai            归一化模型、消息、工具和 Provider Stream
pi-agent-core    管理消息状态、Agent Loop 和生命周期事件
pi-coding-agent  加入 Session、资源、Extension、Package、信任控制和运行外壳
```

这种分层也表达了一种产品选择：Core 保持通用，Workflow 交给 Extension 或外部环境。Sub-agent、规划、权限确认、Todo 系统和 MCP 不必写死在 Loop 里，它们可以组合在 Loop 周围。

重点不是复制 Pi，而是判断哪些职责属于 Model Adapter，哪些属于 Loop，哪些应当留在二者之外。

## 十三节课，十三条不变量

> **s01** *“工具结果会成为模型下一次判断的依据”*：真实模型可以请求 `read_file`，Harness 执行工具，再把结果交回模型继续回答。
>
> **s02** *“工具由公开契约和私有 Handler 组成”*：模型看到 JSON Schema，只有 Harness 能看到可执行代码。
>
> **s03** *“流式传递状态，而不只是文本”*：文本和工具调用以 Event 到达，同时保留尚未组装完成的 Assistant Message。
>
> **s04** *“工具执行拥有生命周期”*：调用、结果和下一次模型 Turn 作为独立 Event 保持可观察。
>
> **s05** *“策略应放在执行周围，而不是写进每个工具”*：Hook 可以阻止、改写或结束一次调用，不必污染 Handler。
>
> **s06** *“Turn 是快照，不是一组全局变量”*：Message、Tool、资源、Model 和 System Prompt 组成显式状态。
>
> **s07** *“History 能够分支才更有用”*：Append-only Entry 和 Parent ID 在不改写过去的情况下保留不同选择。
>
> **s08** *“上下文应当被选择，而不是一次性倾倒”*：项目指令、Skill 和 Prompt Template 只能通过资源边界进入。
>
> **s09** *“Kernel 保持精简，Workflow 交给 Extension”*：Event、Tool、Command 和 Custom Message 通过稳定接口接入。
>
> **s10** *“一个 Runtime，多种运行外壳”*：Interactive、Print/JSON、RPC 和 SDK 模式共享同一份 Session State。
>
> **s11** *“Project Trust 控制加载，不负责限制执行”*：项目设置、Extension、Prompt 和 Package 需要经过信任判断；需要沙箱时，应在 Pi 之外提供。
>
> **s12** *“能力通过 Package 迁移”*：Manifest、约定、Filter 和 Scope 把本地资源变成可分发单元。
>
> **s13** *“集成会检验边界”*：完整 Harness 通过同一条真实 Provider 路径运行，不需要越过早期模块的公开接口访问私有状态。

## 核心模式

```ts
while (true) {
  const assistant = await provider.complete({ messages, tools });
  messages.push(assistant);

  const calls = assistant.content.filter(isToolCall);
  if (calls.length === 0) break;

  for (const call of calls) {
    messages.push(await executeTool(call));
  }
}
```

从 s01 到 s13，这条 Loop 始终清晰可辨。后续课程改善它的输入、输出、持久化和边界，但不会用脚本 Workflow 代替模型判断。

## 从 s01 开始使用真实 Provider

`npm run s01` 到 `npm run s13` 都会调用 OpenAI-compatible Provider。每次运行的回答措辞和工具选择可能不同。学习时请跟踪稳定的结构：User Message 进入，Provider Event 描述响应，工具调用经过 Harness，工具结果再返回模型。

## 快速开始

需要 Node.js 22.19 或更高版本。

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness/learn-pi-agent
npm install
cp .env.example .env
# 编辑 .env，填写 OPENAI_API_KEY。

npm run s01
```

`OPENAI_MODEL` 默认使用 `gpt-4o-mini`，`OPENAI_BASE_URL` 默认使用 OpenAI 官方 API。一次典型运行会经过下面的结构，但具体文本和工具选择可能不同：

```text
user -> model tool call -> read_file result -> model answer
```

随后依次运行 `npm run s02` 到 `npm run s13`。每条命令都会通过同一条真实 Provider 路径运行对应课程。

| 环境变量 | 必填 | 含义 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 是 | 所选 Endpoint 接受的凭据 |
| `OPENAI_MODEL` | 否 | Chat Completions 模型，默认值为 `gpt-4o-mini` |
| `OPENAI_BASE_URL` | 否 | OpenAI-compatible Base URL，默认值为 `https://api.openai.com/v1` |

s01 只向模型提供一个限定在课程工作区内的只读 `read_file` 工具。它不能运行 Shell Command，也不能读取工作区根目录以外的文件。API Key 应保存在 Git 不跟踪的 `.env` 中。

## 学习路线

```text
阶段一：建立协议
  s01 Agent Loop -> s02 Tool Schema -> s03 Provider Events

阶段二：运行可观察的 Turn
  s04 Evented Tool Loop -> s05 Tool Hooks -> s06 Turn State

阶段三：扩展为 Coding Agent 产品
  s07 Session Tree -> s08 Context Resources -> s09 Extension Runtime

阶段四：加入运行外壳与加载边界
  s10 Runtime Modes -> s11 Project Trust -> s12 Pi Package

阶段五：集成 Harness
  s13 Integrated Harness
```

第一遍请按顺序学习。后续章节会直接导入前面章节的公开 Export。这种依赖本身也是教材，它会展示一个接口能否承受下一项需求。

## 全部章节

| 章节 | 主题 | 新增内容 |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | 真实模型调用安全的只读工具，并使用结果继续回答 |
| [s02](s02_tool_schema/) | Tool Schema | 将模型可见的定义与本地 Handler 分开 |
| [s03](s03_provider_events/) | Provider Events | 文本和工具调用 Delta 归一化为一套 Event 协议 |
| [s04](s04_evented_tool_loop/) | Evented Tool Loop | 工具调用、结果和模型继续执行都会发出生命周期 Event |
| [s05](s05_tool_hooks/) | Tool Hooks | Before/After Policy 包围分发过程 |
| [s06](s06_turn_state/) | Harness Turn State | Session、资源、Tool、Model 和 Prompt 组成快照 |
| [s07](s07_session_tree/) | Session Tree | Append-only JSONL History 获得分支能力 |
| [s08](s08_context_resources/) | Context Resources | 发现指令、Skill、Prompt 和 Active Tool |
| [s09](s09_extension_runtime/) | Extension Runtime | Extension 注册 Hook、Tool、Command 和 Message |
| [s10](s10_runtime_modes/) | Runtime Modes | Print/JSON、RPC、SDK 和 Interactive 外壳共享一个 Core |
| [s11](s11_project_trust/) | Project Trust | 控制项目输入的加载，不把信任判断说成执行沙箱 |
| [s12](s12_pi_package/) | Pi Package | 通过 Manifest、约定、Filter 和 Scope 解析资源 |
| [s13](s13_integrated_harness/) | Integrated Harness | 前 12 节通过同一条真实 Provider 路径组成完整 Harness |

## 每节课怎么学

每节课使用相同的紧凑结构：

```text
sNN_topic/
  README.md        完整英文课程
  README.zh.md     完整中文课程
  README.ja.md     完整日文课程
  code.ts          最小可运行实现
  code.test.ts     行为不变量与边界测试
  pi-source.md     固定版本的 Pi 源码对照
  pi-source.zh.md  中文源码对照
```

阅读每个函数之前，先运行 `npm run sNN`。观察模型工具链路，以及这一节加入的 Event 或 State。然后改一个 Prompt、Tool 或边界，再次运行本节，并与下一节的实现对照。

## 源码依据与课程边界

所有源码溯源链接都固定到 [`earendil-works/pi` commit `2f5066d7`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/)，对应编写课程时使用的 Pi 0.79.1 源码快照。从零搭建的教学结构也注明参考了 [`shareAI-lab/claw0` commit `0090e863`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/)。学习不需要本地 Reference Clone。

可运行课程依赖 `@earendil-works/pi-ai` 0.79.1 提供真实 Provider 和模型协议，让课程可以专注于 Harness 行为。课程有意不实现 Terminal UI、动态 Extension Import、Package 安装、上下文压缩的自动触发、截断点选择与摘要生成、Hot Reload、多模态消息、自动重试和进程或容器沙箱。它是一门 Harness Engineering 课程，不是完整的 Pi CLI 重实现。

## 项目结构

```text
learn-pi-agent/
  README.md / README.zh.md / README.ja.md
  .env.example
  package.json
  shared/
  s01_agent_loop/
  ...
  s13_integrated_harness/
```

## 学完后应该能够解释什么

- 为什么流式 Provider Event 比最终字符串携带更多不变量。
- 为什么 Tool Schema、Handler、Hook 和 Project Trust 是不同边界。
- Append-only、可分支 Session 如何改变恢复与审计能力。
- 为什么 Project Trust 不是 Sandbox。
- 为什么 Runtime Mode 只应拥有展示方式，不应拥有 Agent State。
- 同一条真实 Provider 路径如何经过 13 层累积。

目标是能够指出 Model、Provider、Loop、Tool、Session 和运行外壳之间的每条边界，并解释移动边界会破坏什么。

本课程遵循仓库根目录的 [MIT License](../LICENSE)。

**保持 Kernel 精简，保持 Event 清晰。让模型决策，让每一条 Harness 边界都明确可见。**
