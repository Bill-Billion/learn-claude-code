# s13 · Integrated Harness

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the assembly layer that resolves trust and resources, constructs one Agent Session runtime, and exposes it through CLI and SDK shells.

```text
files + trust policy + package entries + Extension factories
  -> Project Trust
  -> direct Resources + Package Resolver
  -> Extension runner + Skills + Prompt Templates
  -> one MiniCoreRuntime
       +-> real Model and Tool loop
       +-> one AgentMessage Session
  -> serialized IntegratedHarnessRuntime
  -> Print / JSON / RPC / SDK
```

## The problem

Each earlier lesson proves one boundary in isolation. A usable Harness has to compose them in the correct order.

Trust must resolve before project Extensions and packages are selected. Package paths must resolve before Extension factories load. Context, Skills, and explicitly invoked Prompt Templates must reach the same Turn as the Tool registry. Every shell must share one AgentMessage Session. Two callers must not mutate that Session concurrently.

If the assembly layer reimplements any of those parts, the course ends with a second, incompatible Agent. s13 therefore adds orchestration and one concurrency rule, not another Model-Tool loop.

## The idea

`createIntegratedHarnessRuntime()` accepts host-owned dependencies and configuration, then connects the public APIs from s01-s12:

| Host input | Where it goes |
| --- | --- |
| `Model<Api>` and Stream options | the real s03-s06 Model path |
| Tool registry and active Tool names | the real Tool loop |
| `MiniSession<AgentMessage>` | one cumulative Session Tree |
| Resource source and direct paths | Context, Skills, and Prompt Templates |
| user/project Package entries | s12 Package Resolver |
| path-to-Factory map | direct and packaged Extensions |
| Trust policy and Store | s11 Project Trust |

The result is an `IntegratedHarnessRuntime`. It implements the s10 `MiniRuntime` contract, exposes `projectTrusted`, `projectInputs`, and `packageResources` for inspection, and preserves explicit Prompt Template invocation.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s13 -- "Use read_file to inspect package.json, then explain which components share the integrated Session."
```

The CLI uses the configured real Model, filesystem Context Resource source, Session Tree, `read_file` Tool, and Print shell. Model output and Tool choice can vary; all of that behavior goes through the integrated path constructed by `createIntegratedHarnessRuntime()`.

`PI_PROJECT_TRUST` defaults to `ask`. This compact CLI has no trust-selection UI or persistent Store, so protected project inputs remain disabled when an applicable override is required. After reviewing the project, `always` enables them and `never` rejects them:

```bash
PI_PROJECT_TRUST=always npm run s13 -- "Summarize the trusted project resources."
```

The course host does not dynamically import TypeScript or parse project settings into package entries. A trusted direct Extension must have an explicit Factory supplied through the programmatic API; otherwise construction fails. The built-in CLI is therefore appropriate only when its selected project inputs do not require an unconfigured Extension Factory.

## How the code works

### 1. Resolve Trust before selecting project inputs

`createIntegratedHarnessRuntime()` begins with `prepareProjectTrust()`. The decision controls three protected sources:

- direct project Skills and Prompt Templates from s11;
- direct project Extension entrypoints under `.pi/extensions`;
- the entire `projectPackages` list passed by the host.

User Extension, Skill, Prompt, and Package inputs remain independent of project trust. Context candidate files also remain outside the Trust Gate, using the per-directory precedence from s08 and s11.

The decision is available as `runtime.projectTrusted`, and the exact gated paths are cloned into `runtime.projectInputs`.

### 2. Merge Resource paths with explicit Extension factories

Trusted direct project Extension directories pass through s12's entrypoint discovery, so a child `index.ts` can load without treating its `helper.ts` as a second Extension.

`extensionFactories` is a normalized path-to-Factory map. It supplies both direct Extension factories and factories for Extension paths selected from packages. A selected path without a Factory is an error; the Harness never interprets a string path as permission to execute source code.

`createPackageRuntime()` merges user paths, trusted project paths, and enabled package paths. Extension factories enter the runner, Skills enter Context Resources, and Prompt files enter the Template catalog. Template bodies are absent from ordinary System Prompts. `runtime.invokePromptTemplate(name, args)` expands one selected Template and queues the expanded User Prompt as a real Turn.

### 3. Keep one real Model and AgentMessage Session

The composed Core is still `MiniCoreRuntime`. It calls the real `runExtensionTurn()` path, which builds Context Resources, runs `before_agent_start` and Tool Hooks, streams the supplied Model, dispatches Tools, emits lifecycle Events, and appends complete `AgentMessage` objects to the supplied Session.

If the host omits `session`, s13 creates a Session Tree. When the host supplies an explicit Session, each Tool-using Turn appends rich Messages in this order:

```text
user
assistant(toolCall)
toolResult
assistant(final text)
```

Context instructions, package Skill metadata, explicit Prompt invocation, Extension-registered Tools, and base Tools all affect that same Session. No adapter flattens rich Messages into plain text.

### 4. Serialize host prompts, then reuse every shell

`IntegratedHarnessRuntime.prompt()` chains work through `promptQueue`. Concurrent calls execute in submission order, so both Runs read and update one stable Session. The queue settles after either success or failure, preventing one rejected Run from blocking later work. Explicit Prompt Template invocation uses the same queue.

`getState()` and `subscribe()` delegate to the Core. That makes the existing s10 helpers reusable without translation:

| Shell | Integrated behavior |
| --- | --- |
| Print | awaits one final text result |
| JSON | serializes captured Events after the Run |
| RPC | supports `prompt` and `get_state` on the same runtime |
| SDK | receives live Events while the queued Turn is running |

## Try it yourself

1. Compose a user package with one Extension Tool, Skill, and Prompt Template. Confirm an ordinary Turn sees the Tool and Skill but not the Prompt body.
2. Call `invokePromptTemplate()` and inspect the last User Message. The expanded text should enter one real queued Turn.
3. Add both user and project packages, then decline Trust. User resources should remain; project packages and direct project Extensions should disappear.
4. Put `index.ts` and `helper.ts` in a trusted direct Extension directory. Supply a Factory only for the entrypoint and verify only that Factory loads.
5. Call Print, JSON, RPC, and SDK in sequence. `getState().turns` and the Session Message list should include all four.
6. Start two `prompt()` calls with `Promise.all()`. Their Run IDs and Session Messages should remain in submission order.

## Wiring into the main line

| Boundary | Earlier lessons | s13 composition |
| --- | --- | --- |
| Model and Tool loop | s01-s05 | one real streamed Turn with Hooks and Events |
| AgentMessage state | s06-s07 | one cumulative Session Tree |
| Context and Resources | s08 | Context candidates, Skills, explicit Prompt invocation |
| Extensions | s09 | direct and package-selected explicit Factories |
| Runtime shells | s10 | one shared Print/JSON/RPC/SDK surface |
| Project Trust | s11 | resolves before protected paths participate |
| Packages | s12 | enabled paths enter the same Core |
| Host concurrency | not previously owned | ordered Promise queue around the shared Session |

## Against the Pi source

Pi 0.79.1 performs the same broad assembly through `createAgentSession()`, `AgentSessionRuntime`, `ResourceLoader`, `ProjectTrustStore`, `DefaultPackageManager`, the Extension loader and runner, `AgentHarness`, and Session APIs. CLI modes and SDK calls are shells around that assembled Session.

The course keeps the composition visible and injectable. It accepts an already-created Model, Tool registry, file source, Package entries, and Extension factories. Pi additionally owns settings parsing, model discovery, Extension module loading, package installation, UI services, reload, compaction, and richer Session control.

The transparent Promise queue is a course host policy. Pi does not silently serialize a second `prompt()` while streaming; callers select steering or follow-up behavior. Both designs protect the meaning of an active Session, but their public concurrency contracts differ.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## What you built

The final API is not a diagram of a Harness. It runs the real course Model path, Tool execution, Events, AgentMessage Session, Context Resources, Extensions, Trust Gate, Package Resolver, Prompt Template invocation, and four runtime shells together.

Return to the [course home](../README.md) to review the complete learning path and choose a boundary to extend.
