# Learn Pi Agent

[English](README.md) · 中文 · [日本語](README.ja.md)

这个仓库从 0 到 1 写一个 mini Pi。它不是 Pi 使用教程，也不是 Pi 源码导读，而是围绕 [Pi](https://github.com/earendil-works/pi) 的关键设计理念逐步构建一个简化但结构清晰的 agent harness MVP。

13 节读完，你手里会有一个 provider 可替换、session 可分支、context resource 可加载、extension 可注册、trust 边界可控、package 可解析的 mini agent harness。s13 会把前 12 节的机制接成一条可运行的请求链路。它是确定性、离线的教学实现，不包含真实模型调用、动态 extension import、package 安装、context compaction、hot reload 或执行沙箱。

Pi 的架构主线很清楚：

```text
pi-ai           统一多 provider 的模型、消息、工具调用格式
pi-agent-core   在消息状态上跑 agent loop，向外发事件
pi-coding-agent 把 core 接到终端、session、扩展、技能和运行模式
```

Pi 的产品思想也很硬：内核保持小，工作流交给外层扩展。Pi 没有内置 sub-agent、plan mode、permission popup、todo 系统和 MCP 默认集成，这些能力可以用 extension、skill、pi package、容器或外部工具接进去。课程里的源码只做验证和溯源参考。

## 适合谁

- **适合谁**：会写 TypeScript、用过任意一家 LLM 的 API、想理解 agent 系统如何从零搭起来的开发者。
- **需要的基础**：看得懂 async/await 和 Promise、知道 messages 数组是什么（不懂的话 s01 会带你过一遍）。
- **不需要**：没用过 Pi、没读过 Pi 源码、没学过 agent 框架都可以。
- **预计投入**：每节 30–60 分钟，13 节约 9–13 小时。
- **难度曲线**：s01–s06 平缓；s07 是第一个抽象跃迁点（树结构）；s10–s13 偏工程装配，s12 内容最重。

## 从哪里开始

```bash
npm run session:s01
npm run test:s01
```

每节课都是一个目录：

```text
s01_agent_loop/
  README.md        本节怎么学（英文；README.zh.md 中文，README.ja.md 日文）
  code.ts          最小实现
  code.test.ts     行为测试（给改课人守设计不变量的回归网）
  pi-source.md     Pi 源码验证与溯源（英文；pi-source.zh.md 中文）
```

每节的结构固定：问题 → 思路 → 先跑起来 → 代码怎么写的 → 试一试 → 接入主线 → 对照 Pi 源码 → 下一节。「先跑起来」的输出都是实测的；「试一试」是动手改代码的练习，不是跑测试。

## 课程路线

这 13 节不是 13 个独立 demo，而是同一个 mini-pi 的 13 次迭代——后面的章节直接 import 前面章节的导出。课程按 Pi 的四层架构和一个集成章节展开：

### A. 协议层（s01–s03）—— Pi 怎么和模型说话

```text
s01: Agent Loop
     messages + provider + stopReason，对应 pi-agent-core 的最小状态流

s02: Tool Schema
     model-visible schema + local handler，对应 pi-ai 和 coding-agent 的工具契约

s03: Provider Events
     start / text_delta / toolcall_delta / done，对应 pi-ai 的流式事件协议
```

### B. Core 层（s04–s06）—— agent-core 如何跑一轮又一轮

```text
s04: Evented Tool Loop
     toolCall -> tool execution events -> toolResult -> next turn

s05: Tool Hooks
     beforeToolCall / afterToolCall / terminate

s06: Harness Turn State
     session.buildContext() + active tools + resources + systemPrompt
```

### C. Coding-agent 层（s07–s09）—— 终端产品如何长出来

```text
s07: Session Tree
     JSONL entry + id/parentId + branch navigation

s08: Context Resources
     AGENTS.md、skills、prompt templates、active tools 如何进入一轮请求

s09: Extension Runtime
     on(event)、registerTool、registerCommand、custom message
```

### D. 外壳层（s10–s12）—— 同一个 core 接不同运行方式

```text
s10: Runtime Modes
     同一个 runtime 接 interactive、print/json、rpc、sdk 外壳

s11: Trust And Execution Env
     project trust 控制输入加载，execution env 控制读写和 shell 边界

s12: Pi Package
     manifest、约定目录、filter、scope 如何把资源打包和分享
```

### E. 集成层（s13）—— 前面的机制跑成一条链路

```text
s13: Integrated Harness
     trust -> package/resources/extensions -> turn state -> hooked tool loop -> session -> runtime modes
```

s13 只做适配和编排。tool loop 仍由 s05 执行，session 仍由 s07 保存，resource、extension、trust、package 和 mode 分别复用 s08–s12 的公开接口。全课的设计取舍汇总表在 s13 结尾。

## 固定源码参考

- [`earendil-works/pi`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/)：固定版本的 Pi 上游源码（0.79.1，commit 2f5066d7），用于验证和溯源
- [`shareAI-lab/claw0`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/)：课程结构和从 0 到 1 铺排参考

写法上参考了 `learn-claude-code` 的教学方法（问题先行、最小实现、源码溯源分层），但内容主轴完全来自 Pi 本身的设计取舍。
