# Pi Source Map for s09

s09 maps to Pi's extension runtime.

```text
extension factory
  -> pi.on / pi.registerTool / pi.registerCommand
  -> loaded extension record
  -> ExtensionRunner emits events
  -> tools / commands / prompt hooks enter the session runtime
```

## Mapped files

- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/types.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/extensions.md)
- [`packages/coding-agent/examples/extensions/`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/examples/extensions/)

Specific anchors:

```text
types.ts:435-482          ToolDefinition
types.ts:527-539          ResourcesDiscoverEvent / ResourcesDiscoverResult
types.ts:1045-1048        BeforeAgentStartEventResult
types.ts:1097-1107        RegisteredCommand / ResolvedCommand
types.ts:1120-1155        ExtensionAPI.on(...)
types.ts:1418-1425        RegisteredTool
types.ts:1577-1595        Extension / LoadExtensionsResult
loader.ts:124-170         createExtensionRuntime()
loader.ts:172-208         on / registerTool / registerCommand in createExtensionAPI()
loader.ts:348-365         createExtension()
runner.ts:420-438         getTools() / getToolDefinition()
runner.ts:536-544         hasHandlers()
runner.ts:736-768         generic emit()
runner.ts:862-875         emitToolCall()
runner.ts:980-1044        emitBeforeAgentStart()
runner.ts:1046-1090       emitResourcesDiscover()
extensions.md:3-29        extension capability overview
extensions.md:55-105      Quick Start
extensions.md:1259-1273  pi.on / pi.registerTool
extensions.md:1418-1431  pi.registerCommand
```

## Mapping

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
| `mergeExtensionTools()` | `ExtensionRunner.getTools()` feeding the tool system |
| `runCommand()` | registered slash command handler |

## What s09 simplifies

The real Pi extension runtime carries much more than s09:

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

s09 implements none of these. It keeps only three main lines:

```text
register capabilities
dispatch by event
wire extension results back into the existing turn state
```

Those three lines are enough to explain Pi's design tradeoff: keep the core small, put workflows in extensions.

## How it connects to earlier units

s09 doesn't open up a new system.

```text
s02 Tool Schema          extensions can register new tools
s05 Tool Hooks           extensions intercept tools via tool_call
s06 Turn State           extensions edit the current turn's prompt in before_agent_start
s08 Context Resources    extensions expose resource paths via resources_discover
```

So the extension runtime is more like a layer of sockets. All the earlier mechanisms are still there — just opened up to external modules.

## Suggested reading order

Start with `createExtensionAPI()` in `loader.ts`. There you can see that `pi.on`, `pi.registerTool`, and `pi.registerCommand` all just write into the extension record.

Then read `emitBeforeAgentStart()` and `emitResourcesDiscover()` in `runner.ts`. These two passages show how the runner calls handlers in extension load order and merges their return values.

Finish with the Quick Start in `docs/extensions.md`. A real extension is this unit's demo, scaled up.
