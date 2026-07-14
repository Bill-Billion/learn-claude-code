# s09 · Extension Runtime

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the coding-agent Extension loader and runner, connected to Tool registration, Commands, Resource discovery, and Harness lifecycle Events.

```text
extension factory -> registrations -> runner
                      |   |   |
                      |   |   +-> before_agent_start / resources_discover / tool_call
                      |   +-----> Commands
                      +---------> Tools -> real Harness Turn
```

## The problem

By s08, the Harness has a real model-tool loop, Session history, and Context Resources. Adding every workflow directly to that core would make it product-specific: one user wants a Tool, another wants a Command, another wants a pre-execution guard, and another wants extra Skills.

The core needs stable attachment points that let outside modules add behavior without owning a second Agent Loop.

## The idea

An Extension is a factory that receives a small registration API:

```ts
pi.registerTool(tool);
pi.registerCommand(name, command);
pi.on("before_agent_start", handler);
pi.on("resources_discover", handler);
pi.on("tool_call", handler);
```

Registration and execution are separate. Loading a factory records Tools, Commands, and Event Handlers. `MiniExtensionRunner` invokes them later in load order, when the matching operation occurs.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s09
```

Or ask the built-in lesson Extension to participate:

```bash
npm run s09 -- "Use the note tool to record that the extension runtime is connected, then confirm it."
```

This is still a real model call. The model decides whether and how to use the registered `note` Tool, so wording and Tool Calls can vary. The stable path is that Extension Tools are merged before the Turn snapshot and execute through the same Registry and Tool Loop as built-in Tools.

## How the code works

### 1. Load factories as registration records

`loadMiniExtensions()` runs each supplied factory with `MiniExtensionAPI`. The API only pushes registrations into a `LoadedExtension` record. Duplicate Tool or Command names across loaded Extensions are rejected explicitly.

`MiniExtensionRunner.getTools()`, `getCommands()`, and `runCommand()` operate on cloned records. This lesson accepts factories supplied by the caller; it does not dynamically import Extension files.

### 2. Prepare Resources and Tools before the snapshot

`resources_discover` Handlers may return Skill, Prompt, and Theme paths. The runner tags every path with the reporting `extensionPath`, preserving provenance. s09 passes discovered Skill and Prompt paths into s08's Resource preparation.

`mergeExtensionTools()` rejects conflicts with base Tool names and extends the s02 Registry. Both steps happen before the Harness captures its Tool and Resource snapshot.

### 3. Persist before_agent_start messages

`before_agent_start` Handlers run in Extension load order. Each Handler sees the System Prompt produced by the previous one and may return a revised Prompt plus a Custom Message.

The runner materializes that value as the s06 `CustomMessage` type. `runExtensionTurn()` appends each Custom Message to the Session before starting the live Harness Turn, so the fresh Turn snapshot contains it. At the model boundary, s06's `convertToLlm()` converts it into a model-readable User Message.

### 4. Connect tool_call to the s05 Hook boundary

`createExtensionToolHooks()` adapts the `tool_call` Event to s05's `beforeToolCall`. In `runExtensionTurn()`, the caller's Before Hook runs first. If it rewrites arguments, the Extension policy receives that effective Tool Call; if either layer blocks, the normal error Tool Result is produced and the Handler does not execute. Otherwise the rewritten arguments continue to validation and execution.

Registered Extension Tools themselves use the same schema validation, execution lifecycle, result persistence, and real Provider continuation as base Tools. No Extension path bypasses the main Loop.

## Try it yourself

1. Register an `echo` Tool and a `hello` Command in one factory. Inspect `runner.getTools()`, then invoke the Command with `runCommand()`.
2. Add a `resources_discover` Handler that returns one Skill path. Confirm both the loaded Skill and its `extensionPath` provenance.
3. Add a `tool_call` Handler that blocks `read_file`. Ask the model to read a file and confirm the Session contains an error Tool Result instead of file content.
4. Return a Custom Message from `before_agent_start` and inspect the Session roles before and after the Turn.

## Wiring into the main line

| Boundary | s08 | s09 |
| --- | --- | --- |
| Tool source | base Registry | base plus Extension-registered Tools |
| Commands | none | registered handlers available through the runner |
| Resource paths | caller arguments | caller arguments plus Extension discovery |
| Resource provenance | original file path | path plus reporting `extensionPath` |
| System Prompt | Resource callback | chained `before_agent_start` revisions |
| Tool policy | caller Hook | `tool_call` adapted to the same s05 boundary |
| Live execution | `runContextResourceTurn()` | `runExtensionTurn()` using the same real Loop |

## Against the Pi source

Factory registration, load-order Event dispatch, Tool blocking, Prompt chaining, and Resource provenance map to Pi 0.79.1. Pi exposes many more Events and UI/runtime capabilities; this lesson keeps the smallest subset that composes with s02, s05, s06, and s08.

See [pi-source.md](pi-source.md) for the pinned mapping.

## Next up

[s10 · Runtime Modes](../s10_runtime_modes/) places the same Harness and Extension runtime behind interactive, print/JSON, RPC, and SDK shells.
