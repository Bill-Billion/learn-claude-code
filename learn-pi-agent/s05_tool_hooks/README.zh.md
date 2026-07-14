# 第 5 课 · Tool Hooks

[课程首页](../README.zh.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> 在 Pi 中的位置：`pi-agent-core` 中包围 Tool Execution 边界的 `beforeToolCall` 与 `afterToolCall` 策略。

```text
Tool Call -> before hook -> Handler -> after hook -> Tool Result
```

## 先搞懂：为什么只观察 Tool Execution 还不够

s04 让 Tool Execution 可以被观察，但观察本身不能改变行为。产品可能需要阻止操作、改写批准后的参数、标记结果、把成功改判为失败，或者在下一次模型 Turn 前结束。

把每条规则写进每个 Handler 会重复 Policy；把产品特定条件直接加入 Agent Loop，又会让 Core 难以复用。执行边界需要两个窄接口，分别位于 Handler 前后。

## 思路：用两个可选 Hook 包围默认执行

```text
beforeToolCall
  -> block：不运行 Handler，返回 Error Tool Result
  -> arguments：替换校验与执行使用的参数
  -> 其他情况：继续

executeDefault

afterToolCall
  -> 改写 content 或 isError
  -> 请求 terminate
```

Loop 仍然管理 Message 顺序和生命周期 Event。Hook 可以影响一次 Tool Call，但不会变成第二条 Agent Loop。

## 先跑起来看看

配置好课程 `.env` 后，从 `learn-pi-agent/` 运行：

```bash
npm run s05
```

下面的单次请求会经过支持 Hook 的 Loop：

```bash
npm run s05 -- "使用 read_file 读取 package.json，并报告 pi-ai 版本。"
```

默认 CLI 没有安装 Policy Hook，因此这条命令展示的是新接口的基线路径。回答和 Tool Call 细节可能变化。接下来的练习会在同一个 `runHookedToolLoop()` 调用中加入 Hook，观察 Tool Result 如何改变。

## 代码怎么写的

### 1. 保持 Hook Return Value 精简

`beforeToolCall` 可以返回：

```ts
{
  block?: boolean;
  reason?: string;
  arguments?: Record<string, unknown>;
}
```

`afterToolCall` 可以返回：

```ts
{
  content?: ToolResultMessage["content"];
  isError?: boolean;
  terminate?: boolean;
}
```

返回 `undefined` 表示不做修改。Hook 不会直接改变 Registry 或 Message History。

### 2. 提供足够的执行上下文

两个 Hook 都会收到 Assistant Message、Tool Call、有效参数和当前 Message。After Hook 还会收到 Tool Result 与它的 `isError` 值。这些信息足以做 Policy 判断，同时不会暴露 Loop 内部的局部控制变量。

### 3. 包围 s04 的默认 Executor

主要入口接收一个 Options Object：

```ts
await runHookedToolLoop({
  model,
  prompt,
  registry,
  hooks: { beforeToolCall, afterToolCall },
});
```

内部的 `createHookExecutor()` 会成为 s04 的 `executeToolCall` 函数。它先运行 Before Hook；如果参数被替换，就构造 Effective Tool Call；只有允许执行时，才调用 `context.executeDefault(effectiveToolCall)`。

### 4. 让模型看见被阻止的调用

Before Hook 返回 `{ block: true }` 时，Handler 不会执行。Hook 的 `reason` 会变成 Error `ToolResultMessage`，通过正常生命周期追加并返回模型。

被阻止的调用不会运行 After Hook，因为没有 Handler Result 需要收尾。

### 5. 执行后再完成结果

默认执行完成后，`afterToolCall` 可以替换 `content`、修改 `isError`，或返回 `terminate: true`。替换后的值仍是普通 Tool Result Message，因此 s04 会照常为它发出 Tool Execution 和 Message Event。

如果 `afterToolCall` 抛错，Handler 此时已经执行。`applyAfterToolCallHook()` 会保留已执行 Tool Result 的 Content，追加 `Post-tool hook failed after the tool executed: ...`，把 Result 标记为 Error，再让 Loop 继续。它绝不会重试 Handler 或重复其 Side Effect。

一个 Turn 包含多个 Tool Call 时，只有这一批中的每个执行结果都请求终止，Loop 才会提前停止。混合批次仍会进入下一次模型 Turn。

## 动手试一试

1. 在 `runLiveCli()` 中加入 `beforeToolCall` Hook，当 `args.path === "README.md"` 时阻止 `read_file`。请求这个文件，确认模型收到你的 Reason，而不是文件内容。
2. 模型请求其他路径时返回 `{ arguments: { path: "package.json" } }`。确认 Handler 读取改写后的路径，Tool Result 仍保留原来的 Tool Call ID。
3. 加入 `afterToolCall` Hook，在文本内容前添加 `audited:`。随后返回 `terminate: true`，比较它与正常后续模型 Turn 的生命周期。

## 接入课程主线

| 边界 | s04 | s05 |
| --- | --- | --- |
| Loop 入口 | `runEventedToolLoop()` | `runHookedToolLoop({ ... })` |
| 默认执行 | Registry Runtime | Hook Wrapper 内的 `executeDefault()` |
| 执行前策略 | 无 | 阻止或替换参数 |
| 执行后策略 | 无 | 改写结果或请求终止 |
| 生命周期 | Agent / Turn / Message / Tool | 同一生命周期，使用收尾后的 Tool Result |
| 模型访问 | 真实 Provider 路径 | 同一条真实 Provider 路径 |

## 对照 Pi 源码

Hook 位置、阻止行为、结果收尾和批量终止规则都对应 Pi 0.79.1。本课额外加入一个小型参数改写字段，让执行前转换保持可见；Pi 的准确 Hook Result Type 与更完整 Context 会在源码对照中说明。

固定源码映射见 [pi-source.zh.md](pi-source.zh.md)。

## 下一课

[第 6 课 · Harness Turn State](../s06_turn_state/) 会把 Message、Tool、Resource、Model 配置和 System Prompt 收进一份显式 Turn Snapshot。
