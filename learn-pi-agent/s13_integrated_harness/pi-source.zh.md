# s13 的 Pi 源码对照

s13 对应的不是一个单独类，而是 Pi 里从资源加载到 agent loop 的组合链路。本节继续以仓库内固定的 `@earendil-works/pi-coding-agent` 0.79.1 和 commit `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210` 为准。

## 对应文件

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/session/session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/session/session.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/session-manager.ts)
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/sdk.ts)

具体锚点：

```text
agent-loop.ts:31-67                 agentLoop() 接收 context、tools 和 loop config
agent-loop.ts:279-303               provider 请求携带 systemPrompt、messages 和 tools
agent-loop.ts:564-628               beforeToolCall、tool dispatch 和 blocked result
agent-harness.ts:332-359            session.buildContext() 和 turn state
agent-harness.ts:367-446            systemPrompt、tools 和 beforeToolCall 接到 agent loop
agent-harness.ts:488-512            agent message 写回 session
agent-harness.ts:571-596            before_agent_start 修改 system prompt
harness/session/session.ts:114-144  buildContext() 和 appendMessage()
project-trust.ts:45-112             project trust 决策顺序
resource-loader.ts:331-468          trust、package resolve、extension/resource load
package-manager.ts:885-921          project/user package 与 local resource 汇总
extensions/runner.ts:867-905        tool_call handler 按加载顺序执行
extensions/runner.ts:980-1042       before_agent_start handler 链
extensions/runner.ts:1052-1090      resources_discover handler 链
agent-session.ts:404-430            tool_call event 接到 agent beforeToolCall
agent-session.ts:1099-1125          prompt 前运行 before_agent_start
session-manager.ts:950-984          message 追加到 JSONL session tree
sdk.ts:166-330                      createAgentSession() 组装 SDK session
```

## 对应关系

| s13 | Pi |
| --- | --- |
| `createIntegratedHarnessRuntime()` | coding-agent 的 session/service/runtime 组装层 |
| `resolveProjectTrusted()` | `project-trust.ts` 的 trust resolution |
| `resolvePiPackages()` | `DefaultPackageManager.resolve()` |
| path-to-factory map | 已完成模块加载后的 extension module 集合 |
| `createExtensionTurnState()` | resource loader、system prompt builder 和 `before_agent_start` |
| provider adapter | `AgentHarness.createTurnState()` 到 `agentLoop()` 的 context 传递 |
| `runner.emitToolCall()` | extension runner 的 `tool_call` event |
| `runHookedToolLoop()` | `agent-loop.ts` 的 tool loop 和 hook dispatch |
| tagged JSON session adapter | Pi 的 rich `AgentMessage` 到 session entry 持久化 |
| `MiniRuntime` shells | coding-agent CLI mode 和 SDK 围绕同一 session 的外壳 |

## 本节采用的简化

真实 Pi 会动态加载 extension module，合并 settings，处理 package 安装路径、资源 precedence、name collision、reload、compaction、模型选择和终端 UI。s13 只保留这条可观察链路：

```text
trust
  -> package/resource resolution
  -> extension registration
  -> turn state
  -> provider + hooked tool loop
  -> session persistence
  -> runtime shell
```

文件和 extension module 都由内存 fixture 提供。path-to-factory map 代表模块已经被宿主加载，s12 resolver 只决定哪些路径有资格进入 runner。project trust 决定 project-local path 是否参与选择。

s07 的 message contract 比 Pi 的 `AgentMessage` 窄，因此 s13 用 tagged JSON 保存完整 assistant/tool-result object。这是课程内部 adapter，不是 Pi 的 session 文件格式复刻。

## 建议读法

先读 `agent-harness.ts` 的 `createTurnState()` 和 `runLoop()`，这里能看到 session context、system prompt、tools 和 hooks 怎样进入同一轮 loop。

再读 `resource-loader.ts` 的 `reload()`，确认 trust 在 package 和 project extension 解析之前生效。随后看 extension runner 的 `emitBeforeAgentStart()`、`emitResourcesDiscover()` 和 `emitToolCall()`。

最后看 `agent-session.ts` 的事件转发与 `session-manager.ts` 的 append 路径。它们对应 s13 里 loop result 写回 session、不同外壳共享同一 runtime state 的部分。
