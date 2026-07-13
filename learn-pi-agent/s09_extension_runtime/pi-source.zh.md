# s09 的 Pi 源码对照

s09 对应 Pi 的 extension runtime。

```text
extension factory
  -> pi.on / pi.registerTool / pi.registerCommand
  -> loaded extension record
  -> ExtensionRunner emits events
  -> tools / commands / prompt hooks enter the session runtime
```

## 对应文件

- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/types.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/extensions.md)
- [`packages/coding-agent/examples/extensions/`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/examples/extensions/)

具体锚点：

```text
types.ts:435-482          ToolDefinition
types.ts:527-539          ResourcesDiscoverEvent / ResourcesDiscoverResult
types.ts:1045-1048        BeforeAgentStartEventResult
types.ts:1097-1107        RegisteredCommand / ResolvedCommand
types.ts:1120-1155        ExtensionAPI.on(...)
types.ts:1418-1425        RegisteredTool
types.ts:1577-1595        Extension / LoadExtensionsResult
loader.ts:124-170         createExtensionRuntime()
loader.ts:172-208         createExtensionAPI() 的 on / registerTool / registerCommand
loader.ts:348-365         createExtension()
runner.ts:420-438         getTools() / getToolDefinition()
runner.ts:536-544         hasHandlers()
runner.ts:736-768         generic emit()
runner.ts:862-875         emitToolCall()
runner.ts:980-1044        emitBeforeAgentStart()
runner.ts:1046-1090       emitResourcesDiscover()
extensions.md:3-29        extension 能力概览
extensions.md:55-105      Quick Start
extensions.md:1259-1273  pi.on / pi.registerTool
extensions.md:1418-1431  pi.registerCommand
```

## 对应关系

| s09 | Pi |
| --- | --- |
| `MiniExtensionFactory` | extension default export |
| `MiniExtensionAPI` | `ExtensionAPI` |
| `loadMiniExtensions()` | `loadExtensions()` / `loadExtensionFromFactory()` |
| `LoadedExtension` | `Extension` |
| `MiniExtensionRunner` | `ExtensionRunner` |
| `emitBeforeAgentStart()` | `ExtensionRunner.emitBeforeAgentStart()` |
| `emitResourcesDiscover()` | `ExtensionRunner.emitResourcesDiscover()` |
| `emitToolCall()` | `ExtensionRunner.emitToolCall()` |
| `mergeExtensionTools()` | `ExtensionRunner.getTools()` 接入工具系统 |
| `runCommand()` | registered slash command handler |

## 本节采用的简化

真实 Pi 的 extension runtime 比 s09 多很多内容：

```text
UI context
keyboard shortcut
CLI flag
message renderer
provider registration
session replacement
stale ctx protection
resource diagnostics
error listener
command name conflict suffix
custom TUI component
```

s09 没有实现这些。它只保留三根主线：

```text
注册能力
按事件分发
把 extension 结果接回已有 turn state
```

这三根线已经够解释 Pi 的设计取舍：core 保持小，workflow 放在 extension 里。

## 和前几节的关系

s09 不是新开一套系统。

```text
s02 Tool Schema          extension 可以注册新工具
s05 Tool Hooks           extension 用 tool_call 拦截工具
s06 Turn State           extension 在 before_agent_start 改本轮 prompt
s08 Context Resources    extension 用 resources_discover 暴露资源路径
```

所以 extension runtime 更像一层插座。前面的机制都还在，只是开放给外部模块。

## 建议读法

先看 `loader.ts` 的 `createExtensionAPI()`。这里能看到 `pi.on`、`pi.registerTool`、`pi.registerCommand` 都是在写入 extension record。

再看 `runner.ts` 的 `emitBeforeAgentStart()` 和 `emitResourcesDiscover()`。这两段代码说明 runner 如何按 extension 加载顺序调用 handler，并把返回值合并起来。

最后看 `docs/extensions.md` 的 Quick Start。真实 extension 写起来就是本节 demo 的放大版。
