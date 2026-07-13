# s02 的 Pi 源码对照

s02 只讲工具的静态形状：

```text
tool name
tool schema
handler
registry
```

## 对应文件

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/providers/anthropic.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/anthropic.ts)
- [`packages/coding-agent/src/core/tools/index.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/index.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)
- [`packages/coding-agent/src/core/tools/bash.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/bash.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)

具体锚点：

```text
ai/src/types.ts:338-342               Tool（只有 name / description / parameters）
ai/src/providers/anthropic.ts:1187-1203  convertTools()：序列化时只取这三个字段
tools/index.ts: ToolName / allToolNames
tools/index.ts: createTool()
agent/src/types.ts:361-384            AgentTool（带 label 和 execute 的运行时对象）
```

## 对应关系

| s02 | Pi |
| --- | --- |
| `ToolDefinition` | pi-ai 的 `Tool`（模型可见契约，只有 name / description / parameters） |
| `RegisteredTool` | `AgentTool`（运行时对象，`label` 和 `execute()` 都在这一侧） |
| `RegisteredTool.handler` | `AgentTool.execute()` |
| `createDemoToolRegistry()` | `createCodingTools()` / `createAllTools()` |
| `listToolDefinitions()` | provider 序列化层，如 anthropic 的 `convertTools()` |
| `dispatchTool()` | s04 才对应 `executeToolCalls()` |

一个容易搭错的对应：coding-agent 里也有一个叫 `ToolDefinition` 的类型（`createCodingToolDefinitions()` 返回它），但那是**带 `execute()`、`promptSnippet`、`renderCall` 的运行时完整定义**，和 s02 这个"剥掉 handler 的模型可见契约"是两个东西。Pi 里真正做"只留 name/description/parameters"这一步的，是 provider 侧的 `convertTools()`。

## Pi 里的真实工具集合

Pi coding-agent 当前内置工具名：

```text
read
bash
edit
write
grep
find
ls
```

s02 只做 `read` 和 `bash`。`read` 不读文件，`bash` 不执行命令。这样可以先看清楚 schema 和 handler 的关系。

## 和 Pi 的差异

`label` 在 Pi 里是 UI 展示字段（`agent/src/types.ts:362-363` 注释写明 "Human-readable label for UI display"），provider 序列化时不会发送它。所以 s02 把 `label` 放在 `RegisteredTool` 一侧，`listToolDefinitions()` 会把它和 `handler` 一起剥掉。

Pi 的 `AgentTool` 更像这样：

```text
name
label
description
parameters
prepareArguments?
execute(toolCallId, params, signal, onUpdate)
executionMode?
```

s02 暂时没有这些：

```text
TypeBox schema
完整类型校验
toolCallId
AbortSignal
onUpdate
parallel / sequential executionMode
beforeToolCall / afterToolCall
```

这些会在后面的章节逐步加进来。s02 只回答一个问题：工具怎么从一段 schema 变成一张可调用的函数表。
