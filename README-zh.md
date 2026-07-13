[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# Learn Agent Harness

从可运行的最小层开始，逐步构建模型周围的完整系统。

Learn Agent Harness 是一个包含三门课程的 monorepo，目标是讲清楚 Agent 产品究竟如何组装。它不会把行为藏在一个庞大的框架后面，而是逐层展开模型循环、工具、状态、上下文、权限和运行时决策，让你看到模型如何在真实环境中发挥作用。

## 选择一门课程

| 课程 | 你会构建什么 | 技术栈 | 课数 | 语言 | 模型访问 |
| --- | --- | --- | ---: | --- | --- |
| [Learn Claude Code](./learn-claude-code/) | Claude Code 风格的编程 Harness：从单循环发展到目标和多 Agent 工作流 | Python | 22 | 英文、中文、日文 | 实际示例使用 Anthropic API；测试离线运行 |
| [Learn Pi Agent](./learn-pi-agent/) | 小型、事件驱动的 Pi 风格 Harness，包含 Session、Extension、信任边界和 Package | TypeScript | 13 | 英文、中文、日文 | 完全确定性、完全离线 |
| [Learn LangChain](./learn-langchain/) | 从 Model、Prompt、Tool 到 Agent、Memory、LangGraph 和 RAG 的渐进式课程 | Python | 13 | 中文 | 实际示例使用 OpenAI；测试离线运行 |

三门课程彼此独立。学习其中一门时，不需要安装另外两门的依赖。

## 选择学习路线

### 从第一性原理开始

先学 **Learn Claude Code**，看最小 Agent Loop 如何长成完整的编程 Harness。再学 **Learn Pi Agent**，对比事件驱动的 TypeScript 设计；最后用 **Learn LangChain** 把这些底层机制映射到框架抽象。

### TypeScript 与运行时设计

从 **Learn Pi Agent** 开始。它的确定性 Provider 让每个事件和状态变化都可以观察。想继续理解权限、上下文压缩、任务与多 Agent 协作时，再对照 Claude Code 的直接 Python 实现。

### 框架、状态图与 RAG

如果你的近期目标是应用开发，可以从 **Learn LangChain** 开始。随后阅读任意一门实现型课程，理解框架在底层实际编排了什么。

### 架构对照学习

横向阅读三门课程里的同类问题：模型适配、工具调度、Turn State、持久化、上下文控制、扩展点和信任边界。术语会变化，但工程问题会重复出现。

## 什么是 Agent Harness？

一个可用的 Agent 产品由两类能力共同组成：

```text
Agent 产品 = 训练得到的模型 + Harness

Harness = 模型适配器
        + 工具
        + 上下文与知识
        + 状态与记忆
        + 权限
        + 运行时与可观测性
```

模型提供训练得到的能力；Harness 为这些能力提供工作环境：呈现观察、暴露动作、记录状态、执行边界，并决定每次模型调用前后发生什么。

Prompt Chain、编排库和状态图都可以是合理的 Harness 工具。它们负责组织控制流和应用状态，但不会凭空创造 Agency；它们组织的是训练模型的使用方式。

## 共同的核心循环

三门课程最终都会回到同一个与 Provider 无关的循环：

```text
messages = [user_request]

while true:
    response = model(messages, tools)
    messages += response

    if response has no tool calls:
        break

    for call in response.tool_calls:
        result = run_tool_with_policy(call)
        messages += result
```

真实产品会继续加入流式输出、Hook、重试、上下文压缩、持久化、调度、Team 或 Graph。这个循环始终是模型意图与 Harness 行为相遇的地方。

## 三门课程

### Learn Claude Code

22 节渐进式 Python 课程，从最小循环重建一个编程 Agent。内容覆盖工具调用、权限、Hook、Subagent、Skill Loading、上下文压缩、记忆、错误恢复、任务、调度、Agent Team、Worktree 隔离、MCP、Workflow Runtime 与持久目标。

- [English course guide](./learn-claude-code/README.md)
- [中文课程指南](./learn-claude-code/README.zh.md)
- [日本語コースガイド](./learn-claude-code/README.ja.md)

### Learn Pi Agent

13 节 TypeScript 课程构建一个 Provider 可替换的 mini Pi 风格 Harness。课程重点是事件流、Session Tree、Context Resource、Extension、信任边界、Package Resolution 与最终集成。所有示例和测试都不需要模型 Key。

- [English course guide](./learn-pi-agent/README.md)
- [中文课程指南](./learn-pi-agent/README.zh.md)
- [日本語コースガイド](./learn-pi-agent/README.ja.md)

### Learn LangChain

13 节中文 Python 课程，从直接模型调用逐步进入 Prompt、结构化输出、Tool、Agent、Middleware、Memory、Retrieval、LangGraph 和综合项目。每节都提供 Starter、完整实现和离线测试，让抽象落到代码上。

- [中文课程指南](./learn-langchain/README.md)

## 仓库目录

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── CONTRIBUTING.md
├── LICENSE
├── learn-claude-code/
├── learn-pi-agent/
└── learn-langchain/
```

课程依赖、生成站点、本地源码 Clone 和内部规划资料都不会提交到仓库。

## 开始学习

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness
```

然后进入一门课程，按课程指南学习：

```bash
cd learn-claude-code   # Python，22 节
cd learn-pi-agent      # TypeScript，13 节
cd learn-langchain     # Python，13 节
```

上面三个 `cd` 是从仓库根目录出发的三种选择，不是连续执行的步骤。

## 仓库原则

- **把机制展开。** 教学代码应让关键状态变化清晰可见。
- **每次只增加一个概念。** 后一课建立在前一课之上，但不把每章写成生产框架。
- **测试真实边界。** 课程检查保持确定性，不依赖付费模型调用。
- **诚实说明简化。** 每门课程都会区分教学取舍与生产实现。
- **保持翻译同步。** 三语课程修改时，代码块和技术结论必须一起更新。

提交 Pull Request 前，请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
