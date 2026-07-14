# s02 的 Pi 0.79.1 源码对照

s02 把 `pi-ai` 工具契约与 Agent 一侧的可执行对象分开。

```text
Tool schema -> provider
Tool handler -> agent runtime
```

## 对应文件

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/validation.ts)
- [`packages/ai/src/providers/anthropic.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/anthropic.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/coding-agent/src/core/tools/index.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/index.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)

## 对应关系

| s02 | Pi 0.79.1 |
| --- | --- |
| 由 `toPiTool()` 转换的 `ToolDefinition` | `pi-ai` `Tool`：`name`、`description`、`parameters` |
| `RegisteredTool` | `AgentTool` 的教学版对应物 |
| `RegisteredTool.handler` | `AgentTool.execute()` |
| `createToolRegistry()` | Coding Agent Tool Factory 所代表的构造边界 |
| `listToolDefinitions()` | Provider 可见工具列表；Provider Adapter 同样只序列化三个字段 |
| `validateToolCall()` | `dispatchTool()` 直接使用的正式 `pi-ai` 校验函数 |
| `dispatchTool()` | Pi 工具路径中的名称查找、校验和执行部分 |
| `createCourseToolRegistry()` | 一个由 s01 安全读取器支持、限定在课程目录的 `read_file` 工具 |

Pi Coding Agent 里也声明了一个名为 `ToolDefinition` 的类型。那个类型是更完整的 Runtime Definition，包含执行和渲染等行为，并不是本课刻意定义的模型可见 `ToolDefinition`。到了 Provider 边界，可传输契约仍然是 `pi-ai` 的 `Tool` 形状。

## 模型侧 API 暴露什么

课程用私有 `WeakMap` 保存 `{ schema, handler }` Entry，通过 `listToolDefinitions()` 暴露 Schema。Pi 使用的 Runtime Object 比这套 Registry 更完整，但职责边界相同：

```text
provider side：name、description、parameters
agent side：label、execute/handler、策略和运行细节
```

`validateToolCall()` 不是课程自己重写的校验器。它直接来自 `@earendil-works/pi-ai` 0.79.1，根据所选 Tool 的 TypeBox Schema 校验 Tool Call。`dispatchTool()` 会在调用私有 Handler 前直接委托给它。

## s02 做了哪些简化

Pi 的 `AgentTool` 还支持 Tool Call ID、`AbortSignal`、进度更新、可选的参数准备、更完整的 Result Details 和 Execution Mode。s02 只保留展示公开/私有分离所需的部分。

课程 Registry 只有一个可实际运行的只读 `read_file`。它不会引入 Shell 执行，也不是完整的 Coding Agent Tool Set。

## 建议读法

1. 先看 [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts) 中的 `Tool`。
2. 再看 [`packages/ai/src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/validation.ts) 中的 `validateToolCall()`。
3. 阅读 [`packages/ai/src/providers/anthropic.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/anthropic.ts) 的 Provider 转换，确认哪些字段可以传输。
4. 最后把 [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts) 中的 `AgentTool` 与 Coding Agent 下的 Read Tool 和 Tool Factory 对照。
