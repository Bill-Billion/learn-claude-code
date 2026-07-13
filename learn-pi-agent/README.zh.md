# Learn Pi Agent -- 构建一个小而可扩展的 Agent Harness

[English](README.md) | 中文 | [日本語](README.ja.md)

## 模型负责决策，Harness 让决策能够落地

LLM 提供判断力：理解当前处境，决定直接回答还是调用工具，阅读工具结果，再判断下一步。Agent harness 提供运行条件：消息、工具、事件、会话状态、扩展、信任边界和运行外壳。

这门课程以 [Pi](https://github.com/earendil-works/pi) 为设计样本，从零重建这些运行条件。Pi 很适合用来学习，因为它保持内核精简，把产品工作流推到外层。它没有用框架遮住循环，因此模型智能与 harness 机制之间的边界格外容易观察。

```text
模型判断
   |
   v
messages -> provider 事件 -> 工具循环 -> 工具结果 -> messages
                |              |
                v              v
             会话状态       hooks / extensions
                \              /
                 runtime + trust
```

完成 14 节后，你会得到一个 mini Pi：provider 可替换，文本与工具调用可流式传输，工具循环由事件驱动，执行过程可挂接 hook，会话能够分支，上下文能够按需加载，还包含扩展、信任控制、package 发现、四种运行外壳，以及一个可选的真实模型结课项目。

这不是 Pi CLI 使用指南，也不是逐行源码导读。它是一门 harness 工程课程：每节只隔离一个设计决策，用最小实现把决策暴露出来，再把实现追溯到固定版本的 Pi 源码。

## 为什么值得重建 Pi

Pi 把 Agent 产品中经常混在一起的三类职责拆开：

```text
pi-ai            统一模型、消息、工具和 provider stream
pi-agent-core    管理消息状态、agent loop 和生命周期事件
pi-coding-agent  加入会话、资源、扩展、package、trust 和运行外壳
```

这样的分层也决定了它的产品立场：核心保持通用，工作流交给扩展和外部环境。Sub-agent、规划、权限界面、todo 系统和 MCP 都不必硬编码进循环，可以组合在循环周围。

课程的目标不是“复制 Pi”，而是分清哪些职责属于模型适配器，哪些属于循环，哪些不该进入这两者。

## 十四节课，十四条不变量

> **s01** *“循环是 Agent 的心跳”*：追加模型响应，检查停止原因，只在需要行动时继续。
>
> **s02** *“工具等于公开契约加私有 handler”*：模型看到 JSON Schema，只有 harness 接触可执行代码。
>
> **s03** *“流式传递状态，而不只是文本”*：文本和工具调用通过事件到达，并保留部分 assistant 状态。
>
> **s04** *“工具结果就是模型的下一条输入”*：执行结束当前一轮，并向模型提供下一轮所需证据。
>
> **s05** *“策略应围绕执行，而不是写进工具”*：hook 可以阻止、改写或终止执行，不污染 handler。
>
> **s06** *“一轮请求是快照，不是一袋全局变量”*：消息、工具、资源、模型和 system prompt 汇合成显式状态。
>
> **s07** *“历史能够分支，才真正有用”*：append-only entry 和 parent id 保存不同选择，而不是覆盖过去。
>
> **s08** *“上下文需要选择，而不是倾倒”*：项目指令、skill 和 prompt template 只经过资源边界进入请求。
>
> **s09** *“内核保持小，工作流交给扩展”*：事件、工具、命令和自定义消息接入稳定接口。
>
> **s10** *“一个 runtime，多种外壳”*：interactive、print/JSON、RPC 和 SDK 共享同一份会话状态。
>
> **s11** *“Trust 控制加载，隔离控制损害”*：决定什么能进入进程，与限制进程能做什么，是两个问题。
>
> **s12** *“能力通过 package 流通”*：manifest、约定目录、filter 和 scope 把本地资源变成可分发单元。
>
> **s13** *“集成是在检验边界”*：如果模块只能侵入彼此内部才能连接，公开契约就画错了。
>
> **s14** *“离线验证机制，真实流量验证闭环”*：OpenAI-compatible stream 让真实模型选择工具、读取结果并继续回答。

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

从 s01 到 s14，这个循环始终清晰可辨。后续章节改善它的输入、输出、持久化和边界，但不会用脚本工作流代替模型判断。

## 默认离线，按需连接真实模型

课程有两套刻意分开的学习环境：

| 路线 | 章节 | 网络或 API Key | 验证目标 |
| --- | --- | --- | --- |
| 机制主线 | s01-s13 和全部自动化测试 | 不需要 | 事件顺序、工具派发、会话状态、trust、package 与集成行为可确定复现 |
| 真实结课项目 | 仅 s14 `session:s14` | 需要 | 真实模型能够流式输出、拼接工具调用 delta、读取工具结果并继续 s13 循环 |

s14 测试不会访问网络。它使用内存 `ReadableStream` 把任意字节分块喂给 Node 原生 `fetch` 接口，并覆盖 401、429、timeout/abort、畸形或不完整 SSE、超限响应和分片工具参数。因此 CI 仍然完全离线，也不需要凭据。

## 快速开始

环境要求：Node.js 25 或更高版本。课程没有生产依赖。

```bash
git clone https://github.com/Bill-Billion/learn-claude-code.git learn-agent-harness
cd learn-agent-harness/learn-pi-agent
npm ci

npm run session:s01
npm run test:s01
npm run check
```

`npm run check` 会执行 TypeScript 类型检查和完整的离线测试套件。

### 运行真实模型结课项目

s14 使用 OpenAI-compatible Chat Completions 接口和 Node 原生 `fetch`。所选端点必须支持流式响应以及 function/tool call。

```bash
cp .env.example .env
# 编辑 .env：填写 OPENAI_API_KEY 和 OPENAI_MODEL。
# 可以保留 OPENAI_BASE_URL，也可以换成其他兼容服务的 /v1 根地址。

npm run test:s14
npm run session:s14 -- "读取 README.md，用三点解释这门课程"
```

| 变量 | 是否必填 | 含义 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 是 | 所选端点接受的凭据 |
| `OPENAI_MODEL` | 是 | 该端点提供的 chat-completions 模型 |
| `OPENAI_BASE_URL` | 否 | 默认为 `https://api.openai.com/v1` |

真实演示只暴露一个实际工具 `read_course_file`，而且它只能读取本课程目录。它会解析符号链接，拒绝隐藏文件和非普通文件，并且只读取不超过 50,000 字节的有效 UTF-8 文本，因此模型既不能读取本地 `.env`，也不能把无限大的本地文件塞进上下文。Key 保存在仓库已忽略的 `.env` 中。适配器不会自动重试：认证失败、限流、网络失败、中止和协议错误会直接显现，让结课项目教清边界，而不是把边界藏起来。

## 学习路线

```text
阶段 1：理解协议
  s01 Agent Loop -> s02 Tool Schema -> s03 Provider Events

阶段 2：运行可信的一轮
  s04 Evented Tool Loop -> s05 Tool Hooks -> s06 Turn State

阶段 3：长成 coding-agent 产品
  s07 Session Tree -> s08 Context Resources -> s09 Extension Runtime

阶段 4：加入外壳与边界
  s10 Runtime Modes -> s11 Trust & Execution Env -> s12 Pi Package

阶段 5：闭合两条链路
  s13 Integrated Harness -> s14 Real Provider
```

第一次学习请按顺序阅读。后面的章节会直接 import 前面章节的导出，因此依赖链本身也是教学内容：你可以观察一个接口能否经受下一项需求的检验。

## 全部章节

| 章节 | 主题 | 新增内容 |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | `messages`、provider 与 `stopReason` 组成最小循环 |
| [s02](s02_tool_schema/) | Tool Schema | 模型可见的定义与本地 handler 分离 |
| [s03](s03_provider_events/) | Provider Events | 文本和工具调用 delta 统一为一种事件协议 |
| [s04](s04_evented_tool_loop/) | Evented Tool Loop | 执行工具调用并返回结构化结果 |
| [s05](s05_tool_hooks/) | Tool Hooks | before/after 策略包围派发过程 |
| [s06](s06_turn_state/) | Harness Turn State | 会话、资源、工具、模型和 prompt 组成快照 |
| [s07](s07_session_tree/) | Session Tree | append-only JSONL 历史获得分支能力 |
| [s08](s08_context_resources/) | Context Resources | 发现指令、skill、prompt 和 active tools |
| [s09](s09_extension_runtime/) | Extension Runtime | 扩展注册 hook、工具、命令和消息 |
| [s10](s10_runtime_modes/) | Runtime Modes | print/JSON、RPC、SDK 与 interactive 共享一个 core |
| [s11](s11_trust_execution_env/) | Trust and Execution Environment | 输入信任与执行隔离保持分离 |
| [s12](s12_pi_package/) | Pi Package | 资源通过 manifest、约定、filter 和 scope 解析 |
| [s13](s13_integrated_harness/) | Integrated Harness | 前 12 节的公开接口组成一条离线请求链 |
| [s14](s14_real_provider/) | Real Provider | Chat Completions SSE 让真实模型驱动同一条链 |

## 每节课怎么学

每节都采用相同的紧凑结构：

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

按照“问题、思路、先跑起来、代码解析、练习、接入主线、源码对照、下一节”的顺序学习。阅读每个函数前，先运行示例。然后主动改变一条不变量，用测试观察哪些部分依赖它。

## 源码依据与课程边界

所有源码溯源链接都固定到 [`earendil-works/pi` commit `2f5066d7`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/)，对应课程编写时使用的 0.79.1 源码快照。从零到一的教学结构也注明参考了 [`shareAI-lab/claw0` commit `0090e863`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/)。学习不需要任何本地 reference clone。

课程有意不实现终端 UI、动态 extension import、package 安装、上下文压缩、hot reload、多模态消息、provider usage 统计、自动重试和进程/容器沙箱。s14 直接手写一个 OpenAI-compatible adapter，让协议转换保持可见；生产系统通常应使用持续维护的 provider 库和更广泛的一致性测试。

## 项目结构

```text
learn-pi-agent/
  README.md / README.zh.md / README.ja.md
  .env.example
  package.json
  s01_agent_loop/
  ...
  s13_integrated_harness/
  s14_real_provider/
```

## 学完后应该能够解释什么

- 为什么流式 provider event 比最终字符串携带更多不变量。
- 为什么工具 schema、handler、hook 和 execution environment 是不同边界。
- append-only、可分支会话如何改变恢复与审计能力。
- 为什么 project trust 不是 sandbox。
- 为什么 runtime mode 只应拥有展示方式，不应拥有 agent 状态。
- 同一个 s13 循环为什么既能使用确定性 fixture，也能接入真实 s14 provider。

目标不只是让演示给出答案，而是能够指出模型、provider、循环、工具、会话和外壳之间的每一条边界，并解释移动这条边界会破坏什么。

本课程遵循仓库根目录的 [MIT License](../LICENSE)。

**保持内核精简，保持事件清晰。让模型决策，让每一条 harness 边界都明确可见。**
