# 第 2 课 · Tool Schema

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：`pi-ai` 中模型可见的 `Tool` 契约，与 Agent Runtime 保存的可执行工具对象之间的边界。

```text
模型看到：name + description + parameters
Harness 保存：schema + handler
```

## 先搞懂：为什么不能把本地函数直接交给模型

s01 已经跑通模型工具闭环，但唯一的 Tool Runtime 仍把公开 Schema 和可执行 Handler 放在一起。工具数量增加后，这种写法很难保持边界清晰。

模型需要可序列化的契约，Harness 需要可以调用的函数。把整个 Runtime Object 交给 Provider，可能泄露不属于模型契约的字段；只保留 Schema，又没有本地代码可以执行。

## 思路：明确区分工具的两种形态

每个工具都保留两种形态，并显式完成转换：

```text
RegisteredTool
  ├── ToolDefinition：name、description、parameters
  └── ToolHandler：本地可执行函数

ToolRegistry
  ├── listToolDefinitions() -> 给模型的 Tool[]
  └── dispatchTool()        -> 校验后本地执行
```

Registry 就是边界。Provider 收到 Schema 副本，本地分发则按名称找到私有 Handler。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s02
```

也可以在一次请求中明确要求使用工具：

```bash
npm run s02 -- "使用 read_file 读取 README.md，并列出五个学习阶段。"
```

每次回答可能不同。稳定的行为是：模型收到 `read_file` Schema，发出 Tool Call，Registry 调用私有 Handler，然后把结果送回模型。

## 代码怎么写的

### 1. 描述工具的两个侧面

`ToolDefinition` 只包含 `name`、`description` 和 `parameters`。`RegisteredTool` 再加入本地 `handler` 与可选的 UI `label`。

```ts
export type RegisteredTool = ToolDefinition & {
  label?: string;
  handler: ToolHandler;
};
```

模型调用前，这个课程类型会转换成正式的 `pi-ai` `Tool`。

### 2. 建立 Registry 的主 Entry

`createToolRegistry()` 会拒绝重名，把每个定义转换成 `pi-ai` Schema，并在私有 `WeakMap` 中保存 `{ schema, handler }` Entry。通过模型侧 API 使用 Registry 的代码拿不到 Handler。

### 3. 只列出模型可见定义

`listToolDefinitions()` 返回只含三个字段的新对象：

```ts
{
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters,
}
```

这个分离过程是显式的，不依赖 JSON 序列化碰巧丢弃函数。

### 4. 本地分发前先校验

`dispatchTool()` 找到主 Entry，拒绝未知名称并构造 `ToolCall`。它把参数校验直接交给 `pi-ai` `validateToolCall()`；只有这个官方校验器成功后才调用 Handler。

`createRegistryToolRuntime()` 再把这个边界适配回 s01 的 Loop。分发失败会变成 Error `ToolResultMessage`，让模型接收失败信息并继续处理。

### 5. 保留原来的真实循环

`createCourseToolRegistry()` 注册 s01 中同一个安全的 `read_file` 能力。`runToolRegistryAgentLoop()` 把 Registry 支持的 Tool Runtime 传给 `runAgentLoop()`：

```ts
return runAgentLoop({
  ...agentOptions,
  toolRuntime: createRegistryToolRuntime(registry),
});
```

模型工具闭环没有改变，变化的只是 Schema 与 Handler 的归属。

## 动手试一试

1. 在 `createCourseToolRegistry()` 中加入第二个只读工具。使用不同名称，让 Handler 返回一条固定的课程信息，再要求模型调用它。
2. 注册两个同名工具，观察立即出现的 `Duplicate tool` 错误。冲突会在模型调用前被拒绝。
3. 用未知名称或非字符串 `path` 调用 `dispatchTool()`。比较查找错误与 Schema 校验错误，再追踪 `createRegistryToolRuntime()` 如何把二者转换成 Error Tool Result。

## 接入课程主线

| 边界 | s01 | s02 |
| --- | --- | --- |
| 模型可见工具 | `ToolRuntime.tools` | `listToolDefinitions(registry)` |
| 可执行代码 | Inline Tool Runtime | 私有 Registry Handler |
| 参数校验 | `read_file` Runtime 内的 `validateToolCall()` | 集中到 `dispatchTool()` |
| Loop 入口 | `runAgentLoop()` | `runToolRegistryAgentLoop()` |
| 真实能力 | 安全的 `read_file` | 通过 Registry 使用同一个安全 `read_file` |

## 对照 Pi 源码

公开 Schema 使用 `@earendil-works/pi-ai` 0.79.1 同样的 `Tool` 形状和 `validateToolCall()` 入口。Registry 一侧则是 Pi 中更完整的 `AgentTool` Runtime Object 与 Coding Tool 构造过程的缩小版。

固定源码映射以及 Pi 内部两个不同 `ToolDefinition` 名称的区别，见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 3 课 · Provider Events](../s03_provider_events/) 会保留 Registry，并把完整响应替换成正式的 `pi-ai` Event Stream。
