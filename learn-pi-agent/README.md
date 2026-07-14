# Learn Pi Agent -- Build a Small, Extensible Agent Harness

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

## The Model Decides. The Harness Makes Decisions Operable.

An LLM supplies judgment. It reads the situation, chooses whether to answer or use a tool, examines the result, and decides what comes next. An agent harness supplies the conditions that make that judgment usable: messages, tools, events, session state, extensions, trust boundaries, and runtime shells.

This course uses [Pi](https://github.com/earendil-works/pi) as a design reference and rebuilds those conditions from the ground up. Pi keeps its kernel small and leaves product-specific workflows outside the loop. That makes it a useful system for studying where model intelligence ends and harness engineering begins.

```text
model judgment
      |
      v
messages -> provider events -> tool loop -> tool results -> messages
                 |              |
                 v              v
             turn state     hooks / extensions
                  \             /
                   runtime + trust
```

After 13 lessons, you will have a mini Pi with a real model-tool loop, normalized provider events, lifecycle-aware tool execution, branchable sessions, on-demand context, extensions, trust controls, package discovery, and four runtime modes. The first lesson already calls a real model and lets it use a safe, read-only tool; every later lesson develops that same path.

This is not a Pi CLI usage guide or a line-by-line source tour. Each lesson isolates one design decision, builds the smallest implementation that makes it visible, and maps it back to pinned Pi source.

## Why Pi Is Worth Rebuilding

Pi separates three responsibilities that agent products often mix together:

```text
pi-ai            normalizes models, messages, tools, and provider streams
pi-agent-core    owns message state, the agent loop, and lifecycle events
pi-coding-agent  adds sessions, resources, extensions, packages, trust, and shells
```

That separation carries a product opinion: keep the core general and put workflows in extensions or the surrounding environment. Subagents, planning, permission prompts, todo systems, and MCP do not need to be hard-coded into the loop. They can be composed around it.

The lesson is not to copy Pi. It is to identify what belongs in a model adapter, what belongs in the loop, and what should remain outside both.

## Thirteen Lessons, Thirteen Invariants

> **s01** *"A tool result becomes the model's next evidence"* - a real model can request `read_file`, the harness executes it, and the model continues with the result.
>
> **s02** *"A tool has a public contract and a private handler"* - the model sees JSON Schema; only the harness sees executable code.
>
> **s03** *"Stream state, not just text"* - text and tool calls arrive as events that preserve the partially assembled assistant message.
>
> **s04** *"Tool execution has a lifecycle"* - a call, its result, and the next model turn remain observable as separate events.
>
> **s05** *"Policy belongs around execution, not inside every tool"* - hooks can block, rewrite, or finish a call without contaminating its handler.
>
> **s06** *"A turn is a snapshot, not a bag of globals"* - messages, tools, resources, model, and system prompt become one explicit state.
>
> **s07** *"History is useful when it can branch"* - append-only entries and parent IDs preserve alternatives without rewriting the past.
>
> **s08** *"Context is selected, not dumped"* - project instructions, skills, and prompt templates enter only through a resource boundary.
>
> **s09** *"Keep the kernel small; let extensions own workflows"* - events, tools, commands, and custom messages attach through stable interfaces.
>
> **s10** *"One runtime, several shells"* - interactive, print/JSON, RPC, and SDK modes share the same session state.
>
> **s11** *"Project trust controls loading, not execution"* - project settings, extensions, prompts, and packages are gated; a sandbox, when needed, stays outside Pi.
>
> **s12** *"Capabilities travel as packages"* - manifests, conventions, filters, and scopes turn local resources into distributable units.
>
> **s13** *"Integration tests the boundaries"* - the complete harness runs on the same real provider path without reaching through earlier modules' private state.

## Core Pattern

```ts
while (true) {
  const assistant = await provider.complete({ messages, tools });
  messages.push(assistant);

  const calls = assistant.content.filter(isToolCall);
  if (calls.length === 0) break;

  for (const call of calls) {
    messages.push(await executeTool(call));
  }
}
```

The loop remains recognizable from s01 to s13. Later lessons improve its inputs, outputs, persistence, and boundaries. They do not replace model judgment with a scripted workflow.

## A Real Provider from s01

`npm run s01` through `npm run s13` call an OpenAI-compatible provider. The wording of the answer and the model's tool choices can vary between runs. Follow the stable structure instead: a user message enters, provider events describe the response, tool calls pass through the harness, and tool results return to the model.

## Quick Start

You need Node.js 22.19 or newer.

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness/learn-pi-agent
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY.

npm run s01
```

`OPENAI_MODEL` defaults to `gpt-4o-mini`. `OPENAI_BASE_URL` defaults to the official OpenAI API. A typical run follows this shape, although the exact text and tool choice may differ:

```text
user -> model tool call -> read_file result -> model answer
```

Continue with `npm run s02` through `npm run s13`. Each command runs that lesson on the same real provider path.

| Environment variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Credential accepted by the selected endpoint |
| `OPENAI_MODEL` | No | Chat Completions model; defaults to `gpt-4o-mini` |
| `OPENAI_BASE_URL` | No | OpenAI-compatible base URL; defaults to `https://api.openai.com/v1` |

s01 gives the model one read-only `read_file` tool scoped to the course workspace. It cannot run shell commands or read outside that root. Keep the API key in `.env`, which is excluded from version control.

## Learning Path

```text
Phase 1: Establish the protocol
  s01 Agent Loop -> s02 Tool Schema -> s03 Provider Events

Phase 2: Run an observable turn
  s04 Evented Tool Loop -> s05 Tool Hooks -> s06 Turn State

Phase 3: Grow into a coding-agent product
  s07 Session Tree -> s08 Context Resources -> s09 Extension Runtime

Phase 4: Add shells and loading boundaries
  s10 Runtime Modes -> s11 Project Trust -> s12 Pi Package

Phase 5: Integrate the harness
  s13 Integrated Harness
```

Read the lessons in order on the first pass. Later chapters import earlier public exports directly. That dependency is part of the teaching: it shows whether an interface survives the next requirement.

## All Chapters

| Chapter | Theme | What it adds |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | A real model calls a safe read-only tool and continues with its result |
| [s02](s02_tool_schema/) | Tool Schema | Model-visible definitions stay separate from local handlers |
| [s03](s03_provider_events/) | Provider Events | Text and tool-call deltas become one normalized event protocol |
| [s04](s04_evented_tool_loop/) | Evented Tool Loop | Tool calls, results, and model continuation emit lifecycle events |
| [s05](s05_tool_hooks/) | Tool Hooks | Before/after policy wraps dispatch |
| [s06](s06_turn_state/) | Harness Turn State | Session, resources, tools, model, and prompt form a snapshot |
| [s07](s07_session_tree/) | Session Tree | Append-only JSONL history gains branches |
| [s08](s08_context_resources/) | Context Resources | Instructions, skills, prompts, and active tools are discovered |
| [s09](s09_extension_runtime/) | Extension Runtime | Extensions register hooks, tools, commands, and messages |
| [s10](s10_runtime_modes/) | Runtime Modes | Print/JSON, RPC, SDK, and interactive shells share one core |
| [s11](s11_project_trust/) | Project Trust | Gate project-controlled inputs without claiming to sandbox execution |
| [s12](s12_pi_package/) | Pi Package | Resources resolve through manifests, conventions, filters, and scopes |
| [s13](s13_integrated_harness/) | Integrated Harness | The first 12 lessons compose on the same real provider path |

## How to Study Each Lesson

Every lesson uses the same compact layout:

```text
sNN_topic/
  README.md        complete English lesson
  README.zh.md     complete Chinese lesson
  README.ja.md     complete Japanese lesson
  code.ts          smallest runnable implementation
  code.test.ts     behavioral invariants and edge cases
  pi-source.md     pinned Pi source comparison
  pi-source.zh.md  Chinese source comparison
```

Run `npm run sNN` before reading every function. Observe the model-tool path and the events or state introduced by that chapter. Then change a prompt, tool, or boundary, run the lesson again, and compare it with the next implementation.

## Source Grounding and Scope

All source-tracing links are pinned to [`earendil-works/pi` commit `2f5066d7`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/), the Pi 0.79.1 snapshot used while writing the course. The from-zero teaching structure also credits [`shareAI-lab/claw0` commit `0090e863`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/). You do not need a local reference clone.

The runnable lessons depend on `@earendil-works/pi-ai` 0.79.1 for the real provider and model protocol, leaving the course free to focus on harness behavior. The course intentionally omits a terminal UI, dynamic extension imports, package installation, automatic compaction triggers, cut-point selection, summary generation, hot reload, multimodal messages, automatic retries, and a process or container sandbox. It is a harness-engineering course, not a complete Pi CLI reimplementation.

## Project Structure

```text
learn-pi-agent/
  README.md / README.zh.md / README.ja.md
  .env.example
  package.json
  shared/
  s01_agent_loop/
  ...
  s13_integrated_harness/
```

## What You Should Be Able to Explain at the End

- Why streaming provider events carry more invariants than a final string.
- Why a tool schema, handler, hook, and project-trust decision are separate boundaries.
- How append-only, branchable sessions change recovery and auditability.
- Why project trust is not a sandbox.
- Why a runtime mode should own presentation, not agent state.
- How one real provider path survives all 13 layers.

The goal is to point to each boundary among the model, provider, loop, tools, sessions, and shells, then explain what would break if that boundary moved.

This course uses the repository's root [MIT License](../LICENSE).

**Keep the kernel small and the events legible. Let the model decide; make every harness boundary explicit.**
