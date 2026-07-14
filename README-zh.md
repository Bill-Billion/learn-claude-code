[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# Learn Agent Harness：搭建模型身边的系统

一个能力足够的模型可以理解任务并选择下一步行动，但它不能凭空读取仓库、运行命令、保存会话或执行审批规则。Agent Harness 负责把环境展示给模型，提供工具，执行经过允许的动作，维护状态，再把结果送回模型。

Learn Agent Harness 用三门彼此独立、可以实际运行的课程讲清楚这套系统。你可以在 Python 中直接写出 Agent Loop，也可以沿着 TypeScript 事件运行时追踪同一条链路，还可以用 LangChain 的框架抽象完成应用。三种实现的写法不同，面对的工程问题却相同：模型能看到什么、可以做什么、哪些状态需要保留，以及程序如何判断继续还是结束。

## 模型负责选择，Harness 负责让选择落地

一个完整的 Agent 产品由模型能力和运行环境共同组成：

```text
Agent product = trained model + harness

Harness = model adapter
        + tools and action interfaces
        + context and knowledge
        + state and memory
        + permissions and trust boundaries
        + runtime, observation, and recovery
```

模型理解陌生请求，判断下一步该做什么。Harness 把这个判断变成受控操作：转换 Provider 返回结果，分发工具调用，记录执行结果，限制访问范围，并组装下一次模型调用需要的输入。

Prompt Chain、State Graph 和 Workflow Engine 都属于 Harness。固定流程需要明确路由、持久化、重试或审批时，这些机制很有用。它们负责组织模型的使用方式，并不替代模型对未知情况的判断。

| 职责 | 模型 | Harness |
| --- | --- | --- |
| 理解意图和不完整信息 | 主要负责 | 提供相关上下文 |
| 选择回复或工具调用 | 主要负责 | 定义可用动作 |
| 执行命令或 API 调用 | 发出请求 | 按策略执行 |
| 保留会话和长时间任务 | 使用提供的历史 | 存储、压缩并恢复状态 |
| 执行权限规则 | 不能充当信任边界 | 校验、请求批准并隔离执行 |
| 观察失败并继续 | 分析失败原因 | 捕获错误、安全重试并提供证据 |

## 同一个 Agent Loop，三种观察方式

三门课程最终都会回到模型与工具之间的循环：

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

流式输出、Hook、记忆、任务队列、Graph 和多智能体协作都围绕这条循环展开。它们改变的是程序观察和管理一次 Turn 的方式。下一步语义动作仍由模型选择，执行和策略仍归 Harness 管理。

### 每门课程分别展开什么

| 观察方式 | 课程 | 可以直接看到什么 | 重点理解什么 |
| --- | --- | --- | --- |
| 直接实现 | [Learn Claude Code](./learn-claude-code/) | Loop、Handler Map、上下文、持久化、团队和目标校验 | Coding Harness 如何逐个增加机制 |
| 事件驱动运行时 | [Learn Pi Agent](./learn-pi-agent/) | 类型化 Provider Event、Turn State、Session、Extension 和信任判断 | Runtime 如何拆分协议层、Core 和产品外壳 |
| 框架抽象 | [Learn LangChain](./learn-langchain/) | Model、Message、Prompt、Tool、Agent、Middleware、Retrieval 和 RAG | 框架接收什么、返回什么、代替你编排什么 |

三门课放在一起，可以补上两类常见盲区。只学框架容易在调试时看不见关键状态变化；只做从零实现，又容易重复开发已有的稳定抽象。对照学习能帮助你判断什么时候应该展开机制，什么时候应该采用框架。

## 选择一门课程

| 课程 | 适合作为起点的情况 | 技术栈 | 课数 | 语言 | 真实模型路径 |
| --- | --- | --- | ---: | --- | --- |
| [Learn Claude Code](./learn-claude-code/) | 从第一性原理学习 Harness 工程和 Coding Agent 架构 | Python 3.11 | 22 | 英文、中文、日文 | Anthropic-compatible API |
| [Learn Pi Agent](./learn-pi-agent/) | TypeScript 开发者学习协议和事件驱动运行时 | Node.js 22.19+ + TypeScript | 13 | 英文、中文、日文 | 从 s01 开始接入 OpenAI-compatible API |
| [Learn LangChain](./learn-langchain/) | 想用 LangChain 开发，同时理解组件契约的 Python 开发者 | Python 3.11 + uv | 13 | 中文 | 默认使用 OpenAI |

三门课程不共享运行时依赖，只需安装当前课程自己的环境。

## 快速开始

仓库只需 Clone 一次，然后进入你要学习的课程。接下来三个课程章节中的命令都从仓库根目录开始执行。

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness
```

## 课程一：Learn Claude Code

[Learn Claude Code](./learn-claude-code/) 用 22 节递进式 Python 课程重建一个 Coding Harness。课程从最小的模型工具循环开始，在始终能看清主循环的前提下，逐步加入长任务、安全执行和多智能体协作需要的机制。

### 适合谁

如果你希望在没有框架接管主控制流的情况下观察 Agent 机制，可以从这门课开始。它适合 Python 开发者、想理解 Coding Agent 内部结构的使用者，以及准备为其他业务领域设计 Harness 的工程师。

学完后，你应该能够划分模型判断与 Runtime 职责，在不改写主循环的情况下增加工具，管理有限上下文，持久化任务，协调 Subagent，并根据可信证据判断任务是否真正完成。

### 22 节课如何展开

| 课程 | 加入 Harness 的新层次 |
| --- | --- |
| s01-s04 | Agent Loop、工具分发、权限和 Hook |
| s05-s11 | 规划、Subagent、Skill、上下文压缩、记忆、Prompt 和错误恢复 |
| s12-s14 | 持久化任务、后台工作和定时调度 |
| s15-s18 | 团队、协作协议、自动领取任务和 Worktree 隔离 |
| s19-s22 | MCP、完整集成、Workflow Runtime 和基于目标的自动续跑 |

当前 22 节主线是新读者的推荐路径。课程还保留了旧版 12 节内容，供已有读者和旧链接继续使用；[课程目录](./learn-claude-code/)中的指南说明了两版映射关系。

### 运行课程

```bash
cd learn-claude-code
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，填写 ANTHROPIC_API_KEY 后再运行真实模型示例。
python s01_agent_loop/code.py
```

可运行章节读取 `.env` 中的 Provider 配置。课程指南还介绍了由课程内容生成的 Web 学习界面。

- [English course guide](./learn-claude-code/README.md)
- [中文课程指南](./learn-claude-code/README.zh.md)
- [日本語コースガイド](./learn-claude-code/README.ja.md)

## 课程二：Learn Pi Agent

[Learn Pi Agent](./learn-pi-agent/) 用 13 节累积式 TypeScript 课程搭建一个小型 Pi 风格 Runtime。从 s01 开始，真实模型就可以调用一个安全的只读工具，并在下一次回复中使用工具结果。后续课程在保留这条循环的同时，逐步加入 Provider Event、工具生命周期、Turn State、Session、上下文资源、Extension、运行模式、信任校验和 Package 解析。s13 通过同一条真实 Provider 路径集成完整 Harness。

### 适合谁

如果类型边界和运行时事件更符合你的理解方式，可以从这门课开始。它适合 TypeScript 开发者、CLI 与 SDK 作者，以及希望看清协议层、Agent Core 和产品外壳如何解耦的读者。

学完后，你应该能够设计可替换的 Provider 契约，归一化流式事件，在不改变 Core Loop 的情况下提供生命周期 Hook，保存 Session 分支，并把执行策略放在模型输出之外。

### 13 节课如何展开

| 课程 | 加入 Harness 的新层次 |
| --- | --- |
| s01-s03 | 真实模型工具循环、工具 Schema 和归一化 Provider Event |
| s04-s06 | 带生命周期事件的工具执行、Hook 和 Turn State |
| s07-s09 | Session Tree、上下文资源和 Extension Runtime |
| s10-s12 | 运行模式、Project Trust 和 Package 解析 |
| s13 | 通过同一条真实 Provider 路径运行的完整 Harness |

从 s01 开始，各章节命令都会调用真实 Provider。每次运行的具体措辞和工具选择可能不同；学习时应重点观察模型工具循环、事件协议和状态契约。

### 运行课程

```bash
cd learn-pi-agent
npm install
cp .env.example .env
# 编辑 .env，填写 OPENAI_API_KEY。
npm run s01
```

`OPENAI_MODEL` 默认使用 `gpt-4o-mini`，`OPENAI_BASE_URL` 默认使用 OpenAI 官方 API。随后依次运行 `npm run s02` 到 `npm run s13`。因为回复和工具调用由模型选择，实际输出可能与示例不同。

- [English course guide](./learn-pi-agent/README.md)
- [中文课程指南](./learn-pi-agent/README.zh.md)
- [日本語コースガイド](./learn-pi-agent/README.ja.md)

## 课程三：Learn LangChain

[Learn LangChain](./learn-langchain/README.md) 是一门围绕 LangChain 当前公开 API 编写的 13 节中文课程。每节课只增加一个抽象，同时把输入和输出类型留在读者视线内。课程从第一次模型调用开始，逐步加入 Message、Prompt、结构化输出、Tool、Agent、记忆、Retrieval，最后完成一个小型 RAG 应用。

### 适合谁

如果你想开发 LangChain 应用，又不希望把框架当成黑箱，可以选择这门课。它适合具备 Python 基础的初学者，也适合需要快速进入 Agent 与 RAG 开发的应用工程师。

学完后，你应该能够选择合适的 LangChain 组件，判断它接收和返回的类型，追踪消息状态如何经过 Agent，并区分 RAG 链路中应该由 Retrieval、Tool 或模型上下文承担的工作。

### 13 节课如何展开

| 课程 | 加入应用的新层次 |
| --- | --- |
| s01-s05 | 模型调用、Message、System Prompt、Template 和结构化输出 |
| s06-s10 | Tool、Agent、流式输出、短期记忆和 Todo Middleware |
| s11-s13 | Retrieval 基础、最小 RAG 和综合课程助教 |

主线只讲 LangChain 入门所需的稳定骨架。LangGraph 深层编排、MCP、多智能体和生产级外部向量数据库都放在后续进阶路线中，不会成为前 13 节的隐藏前置知识。

### 运行课程

```bash
cd learn-langchain
uv sync --locked
cp .env.example .env
# 编辑 .env，填写 OPENAI_API_KEY 后再运行真实模型示例。
uv run python -m s01_first_model.code
```

示例从 `.env` 读取 `LANGCHAIN_MODEL` 和对应 Provider 的密钥，默认配置使用 OpenAI。s11-s13 也默认使用 OpenAI Embeddings，除非你注入其他 Embedding 实现。

- [中文课程指南](./learn-langchain/README.md)

## 选择学习路线

### 从第一性原理理解架构

先学 Claude Code，再学习 Pi Agent，最后用 LangChain 收尾。这样可以在接触事件协议和框架抽象之前，先看清直接实现。这是覆盖仓库内容最完整的路线。

### 搭建 TypeScript Runtime

从 Pi Agent 开始。当你想比较事件归一化与直接请求循环时，可以对照 Pi Agent 的 s03-s06 和 Claude Code 的 s01-s04。Runtime 开始承担长任务后，再继续学习 Claude Code 中的上下文、任务和团队章节。

### 立即开发 Agent 或 RAG 应用

先完成 LangChain 的 13 节主线，再阅读任意一门实现课程的前四节。第二遍对照能让你看清 `create_agent` 帮你编排了哪些状态和代码路径。

### 横向比较一个工程问题

可以把三门课程当作同一个设计问题的三份实现：

| 关注点 | Learn Claude Code | Learn Pi Agent | Learn LangChain |
| --- | --- | --- | --- |
| 模型边界 | Anthropic Content Block 和 `stop_reason` | Provider 契约和归一化事件 | `init_chat_model` 和 Message Object |
| 工具边界 | JSON Schema 和 Handler 分发 | 类型化 Schema、Event 和执行 Hook | `@tool` 和 Agent 管理的 Tool Message |
| Turn State | `messages` 加显式 Runtime State | Event Stream 和 `TurnState` | Agent State 和 Message History |
| 扩展机制 | Hook、Skill 和 MCP | Hook、Extension 和 Package | Middleware 和可组合组件 |
| 上下文 | Skill、Memory 和 Compaction | 上下文资源和 Session 分支 | Prompt、Checkpointer 和 Retrieval |
| 控制机制 | Permission、Task、Workflow 和 Goal | Trust Check 和 Runtime Mode | Agent 编排和 Middleware |

## 每门课程怎么学

1. 先读课程指南，并在修改代码前运行第一节课。
2. 按课程目录顺序学习，每次只确认相对上一节新增了什么机制。
3. 运行当前章节入口，观察它输出的状态或事件。
4. 修改一处边界，比如增加工具、拒绝动作、创建 Session 分支或改变上下文资源。
5. 再次运行本节，然后和下一节的实现对照。

可运行示例是课程的学习主线。模型每次输出的具体措辞可能不同，应比较模型工具循环、Event 和 State，而不是固定 Transcript。三门课程各自使用独立环境和 Lockfile，因此根目录没有统一安装命令。

## 仓库目录

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── CONTRIBUTING.md
├── LICENSE
├── .github/workflows/       # independent course checks and repository hygiene
├── learn-claude-code/       # 22 Python lessons, trilingual
├── learn-pi-agent/          # 13 TypeScript lessons, trilingual
└── learn-langchain/         # 13 Python lessons, Chinese
```

依赖目录、生成站点、缓存、本地源码 Clone、内部计划和模型工作区文件都不应进入公开仓库。

## 仓库边界

- 每节课只展开一个新机制。这些代码用于教学，不是生产 SDK。
- 后续课程可以集成前面的代码，但三门课程各自维护依赖和检查。
- 真实示例可能需要付费 Provider 账号。
- Claude Code 和 Pi Agent 保持英文、中文、日文三语同步；Learn LangChain 当前只提供中文课程。
- 简化过的权限、存储或 Provider Adapter 会明确标注，不把教学实现包装成生产级系统。

## 参与贡献

提交 Pull Request 前，请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。课程数量、命令、Provider 行为或课程范围发生变化时，需要同步更新根目录三份 README。修改三语课程时，也要同步课程目录内的三份指南。

请运行所有受影响课程的检查，不要提交生成产物、依赖目录、本地参考源码、草稿和内部计划。

## 许可证

[MIT](./LICENSE)
