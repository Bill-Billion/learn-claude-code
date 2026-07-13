# Learn Pi Agent

English · [中文](README.zh.md) · [日本語](README.ja.md)

This repo builds a mini Pi from scratch. It's not a Pi usage tutorial, and it's not a guided tour of the Pi codebase — it takes the key design ideas behind [Pi](https://github.com/earendil-works/pi) and builds a simplified but cleanly structured agent harness MVP, step by step.

After 13 lessons you'll have a mini agent harness where providers are swappable, sessions can branch, context resources are loadable, extensions are registrable, trust boundaries are enforced, and packages are resolvable. s13 wires the mechanisms from the first 12 lessons into one runnable request chain. It's a deterministic, offline teaching implementation — no real model calls, no dynamic extension imports, no package installation, no context compaction, no hot reload, no execution sandbox.

Pi's architectural through-line is clear:

```text
pi-ai           Unifies model, message, and tool-call formats across providers
pi-agent-core   Runs the agent loop over message state and emits events
pi-coding-agent Wires the core into the terminal, sessions, extensions, skills, and run modes
```

Pi's product philosophy is just as firm: keep the kernel small, push workflows to the outer layers. Pi has no built-in sub-agents, plan mode, permission popups, todo system, or default MCP integration — all of that can be plugged in via extensions, skills, pi packages, containers, or external tools. The Pi source in this course is used only for verification and tracing.

## Who this is for

- **For**: developers who write TypeScript, have used any LLM API, and want to understand how an agent system gets built from zero.
- **You'll need**: comfort with async/await and Promises, and a rough idea of what a messages array is (if not, s01 walks you through it).
- **You won't need**: any Pi experience, any time in the Pi codebase, or any agent framework background.
- **Time budget**: 30–60 minutes per lesson, roughly 9–13 hours for all 13.
- **Difficulty curve**: s01–s06 are gentle; s07 is the first abstraction jump (tree structures); s10–s13 lean toward engineering assembly, with s12 being the heaviest.

## Where to start

```bash
npm run session:s01
npm run test:s01
```

Each lesson is one directory:

```text
s01_agent_loop/
  README.md        How to work through the lesson (English; README.zh.md Chinese, README.ja.md Japanese)
  code.ts          Minimal implementation
  code.test.ts     Behavior tests (a regression net that guards the design invariants for anyone editing the course)
  pi-source.md     Verification and tracing against the Pi source (English; pi-source.zh.md Chinese)
```

Every lesson follows the same structure: The problem → The idea → Run it first → How the code works → Try it yourself → Wiring into the main line → Against the Pi source → Next up. All output in "Run it first" is captured from real runs; "Try it yourself" means hands-on code changes, not running the tests.

## Course roadmap

These 13 lessons are not 13 standalone demos — they're 13 iterations of the same mini-pi, and later lessons import directly from earlier ones. The course follows Pi's four architectural layers plus one integration lesson:

### A. Protocol layer (s01–s03) — how Pi talks to the model

```text
s01: Agent Loop
     messages + provider + stopReason, mapping to the minimal state flow of pi-agent-core

s02: Tool Schema
     model-visible schema + local handler, mapping to the tool contract in pi-ai and coding-agent

s03: Provider Events
     start / text_delta / toolcall_delta / done, mapping to pi-ai's streaming event protocol
```

### B. Core layer (s04–s06) — how agent-core runs turn after turn

```text
s04: Evented Tool Loop
     toolCall -> tool execution events -> toolResult -> next turn

s05: Tool Hooks
     beforeToolCall / afterToolCall / terminate

s06: Harness Turn State
     session.buildContext() + active tools + resources + systemPrompt
```

### C. Coding-agent layer (s07–s09) — how the terminal product grows

```text
s07: Session Tree
     JSONL entry + id/parentId + branch navigation

s08: Context Resources
     how AGENTS.md, skills, prompt templates, and active tools get into a single request

s09: Extension Runtime
     on(event), registerTool, registerCommand, custom message
```

### D. Shell layer (s10–s12) — one core, different ways to run it

```text
s10: Runtime Modes
     one runtime behind interactive, print/json, rpc, and sdk shells

s11: Trust And Execution Env
     project trust gates what inputs get loaded; execution env gates read/write and shell boundaries

s12: Pi Package
     how manifest, convention directories, filter, and scope package resources for sharing
```

### E. Integration layer (s13) — the pieces running as one chain

```text
s13: Integrated Harness
     trust -> package/resources/extensions -> turn state -> hooked tool loop -> session -> runtime modes
```

s13 only does adaptation and orchestration. The tool loop is still executed by s05, sessions are still persisted by s07, and resources, extensions, trust, packages, and modes each reuse the public interfaces of s08–s12. The design trade-off summary table for the whole course is at the end of s13.

## Pinned source references

- [`earendil-works/pi`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/) - Pinned upstream Pi source (0.79.1, commit 2f5066d7), for verification and tracing
- [`shareAI-lab/claw0`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/) - Reference for the course structure and its zero-to-one progression

The teaching approach borrows from `learn-claude-code` (problem-first, minimal implementations, layered source tracing), but the content's spine comes entirely from Pi's own design trade-offs.
