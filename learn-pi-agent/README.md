# Learn Pi Agent -- Build a Small, Extensible Agent Harness

English | [中文](README.zh.md) | [日本語](README.ja.md)

## The Model Decides. The Harness Makes Decisions Operable.

An LLM supplies the judgment: read a situation, choose whether to answer or use a tool, inspect the result, and decide what comes next. An agent harness supplies the operating conditions: messages, tools, events, session state, extensions, trust boundaries, and runtime shells.

This course rebuilds those conditions from scratch, using [Pi](https://github.com/earendil-works/pi) as the design specimen. Pi is valuable here because it keeps the kernel small and pushes product workflow outward. Instead of hiding the loop behind a framework, it makes the boundary between model intelligence and harness mechanics unusually easy to inspect.

```text
model judgment
     |
     v
messages -> provider events -> tool loop -> tool results -> messages
                |                |
                v                v
          session state     hooks / extensions
                \                /
                 runtime + trust
```

After 14 lessons, you will have a mini Pi with a replaceable provider, streamed text and tool calls, an evented tool loop, hookable execution, branchable sessions, loadable context, extensions, trust controls, package discovery, four runtime shells, and one optional real-model capstone.

This is not a guide to using the Pi CLI, and it is not a line-by-line tour of its source. It is a harness-engineering course: each lesson isolates one design decision, implements the smallest version that exposes the decision, and then traces that version back to pinned Pi source.

## Why Pi Is Worth Rebuilding

Pi separates three concerns that agent products often blur:

```text
pi-ai            normalizes models, messages, tools, and provider streams
pi-agent-core    owns message state, the agent loop, and lifecycle events
pi-coding-agent  adds sessions, resources, extensions, packages, trust, and shells
```

Its product stance follows from that split: keep the core general, and let extensions and external environments own workflow. Sub-agents, planning, permission UI, todo systems, and MCP do not need to be hard-coded into the loop. They can be composed around it.

The lesson is not "copy Pi." The lesson is to recognize which concerns belong in a model adapter, which belong in the loop, and which should stay outside both.

## Fourteen Lessons, Fourteen Invariants

> **s01** *"The loop is the agent's heartbeat"* - append the model response, inspect the stop reason, and continue only when action is required.
>
> **s02** *"A tool is a public contract plus a private handler"* - the model sees JSON Schema; only the harness sees executable code.
>
> **s03** *"Stream state, not just text"* - text and tool calls arrive as events that preserve partial assistant state.
>
> **s04** *"A tool result is the next model input"* - execution closes one turn and gives the model evidence for the next.
>
> **s05** *"Policy belongs around execution, not inside tools"* - hooks can block, rewrite, or terminate without contaminating handlers.
>
> **s06** *"A turn is a snapshot, not a bag of globals"* - messages, tools, resources, model, and system prompt meet in one explicit state.
>
> **s07** *"History becomes useful when it can branch"* - append-only entries and parent ids preserve alternatives instead of overwriting them.
>
> **s08** *"Context is selected, not dumped"* - project instructions, skills, and prompt templates enter only through a resource boundary.
>
> **s09** *"Keep the kernel small; let extensions own workflow"* - events, tools, commands, and custom messages plug into stable interfaces.
>
> **s10** *"One runtime, many shells"* - interactive, print/JSON, RPC, and SDK modes share the same session state.
>
> **s11** *"Trust controls loading; isolation controls damage"* - deciding what may enter a process is different from sandboxing what it may do.
>
> **s12** *"Capabilities travel as packages"* - manifests, conventions, filters, and scope turn local resources into distributable units.
>
> **s13** *"Integration tests the boundaries"* - if modules connect only by reaching into internals, their public contracts were drawn wrong.
>
> **s14** *"Offline proves mechanics; live traffic proves the loop"* - an OpenAI-compatible stream lets a real model choose a tool, read its result, and answer.

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

The loop remains recognizable from s01 to s14. Later lessons change the quality of its inputs, outputs, persistence, and boundaries. They do not replace model judgment with a scripted workflow.

## Offline First, Live by Choice

There are two deliberately separate learning environments:

| Track | Lessons | Network or API key | What it proves |
| --- | --- | --- | --- |
| Mechanism track | s01-s13 and every automated test | Not required | Event order, tool dispatch, session state, trust, packages, and integration are deterministic and reproducible |
| Live capstone | s14 `session:s14` only | Required | A real model can stream text, assemble tool-call deltas, consume a tool result, and continue the s13 loop |

The s14 tests do not call the network. They feed byte-split `ReadableStream` fixtures into Node's native `fetch` interfaces, including 401, 429, timeout/abort, malformed or incomplete SSE, oversized responses, and fragmented tool arguments. CI therefore remains offline and credential-free.

## Quick Start

Requirements: Node.js 25 or newer. There are no production dependencies.

```bash
git clone https://github.com/Bill-Billion/learn-claude-code.git learn-agent-harness
cd learn-agent-harness/learn-pi-agent
npm ci

npm run session:s01
npm run test:s01
npm run check
```

`npm run check` runs TypeScript type checking and the complete offline test suite.

### Run the Real-Model Capstone

s14 uses the OpenAI-compatible Chat Completions endpoint and Node's native `fetch`. Your endpoint must support streaming and function/tool calls.

```bash
cp .env.example .env
# Edit .env: set OPENAI_API_KEY and OPENAI_MODEL.
# Keep OPENAI_BASE_URL, or replace it with another compatible /v1 base URL.

npm run test:s14
npm run session:s14 -- "Read README.md and explain the course in three points"
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Credential accepted by the selected endpoint |
| `OPENAI_MODEL` | Yes | A chat-completions model available from that endpoint |
| `OPENAI_BASE_URL` | No | Defaults to `https://api.openai.com/v1` |

The live demo exposes one real tool, `read_course_file`, confined to this course directory. It resolves symlinks, rejects hidden or non-regular files, and reads at most 50,000 bytes of valid UTF-8, so the model cannot read the local `.env` or turn an unbounded local file into context. The key stays in `.env`, which the repository ignores. The adapter performs no automatic retry: authentication failures, rate limits, network failures, aborts, and protocol errors remain visible so the capstone teaches the boundary instead of hiding it.

## Learning Path

```text
Phase 1: Speak the protocol
  s01 Agent Loop -> s02 Tool Schema -> s03 Provider Events

Phase 2: Run trustworthy turns
  s04 Evented Tool Loop -> s05 Tool Hooks -> s06 Turn State

Phase 3: Grow a coding-agent product
  s07 Session Tree -> s08 Context Resources -> s09 Extension Runtime

Phase 4: Add shells and boundaries
  s10 Runtime Modes -> s11 Trust & Execution Env -> s12 Pi Package

Phase 5: Close both loops
  s13 Integrated Harness -> s14 Real Provider
```

Read in order on the first pass. Later lessons import earlier exports, so the dependency chain is part of the teaching: you can see whether an interface survives contact with the next requirement.

## All Chapters

| Chapter | Topic | What changes |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | `messages`, provider, and `stopReason` form the smallest loop |
| [s02](s02_tool_schema/) | Tool Schema | model-visible definitions separate from local handlers |
| [s03](s03_provider_events/) | Provider Events | text and tool-call deltas become one event protocol |
| [s04](s04_evented_tool_loop/) | Evented Tool Loop | tool calls execute and return structured results |
| [s05](s05_tool_hooks/) | Tool Hooks | before/after policies surround dispatch |
| [s06](s06_turn_state/) | Harness Turn State | session, resources, tools, model, and prompt form a snapshot |
| [s07](s07_session_tree/) | Session Tree | append-only JSONL history gains branches |
| [s08](s08_context_resources/) | Context Resources | instructions, skills, prompts, and active tools are discovered |
| [s09](s09_extension_runtime/) | Extension Runtime | extensions register hooks, tools, commands, and messages |
| [s10](s10_runtime_modes/) | Runtime Modes | print/JSON, RPC, SDK, and interactive shells share one core |
| [s11](s11_trust_execution_env/) | Trust and Execution Environment | input trust stays distinct from execution isolation |
| [s12](s12_pi_package/) | Pi Package | resources resolve through manifest, convention, filter, and scope |
| [s13](s13_integrated_harness/) | Integrated Harness | the first 12 public interfaces become one offline request chain |
| [s14](s14_real_provider/) | Real Provider | Chat Completions SSE drives the same chain with a real model |

## How to Study Each Lesson

Every lesson uses the same compact layout:

```text
sNN_topic/
  README.md        complete English lesson
  README.zh.md     complete Chinese lesson
  README.ja.md     complete Japanese lesson
  code.ts          minimal runnable implementation
  code.test.ts     behavioral invariants and edge cases
  pi-source.md     pinned Pi source cross-reference
  pi-source.zh.md  Chinese source cross-reference
```

Follow the narrative in order: problem, idea, run it first, code walk-through, exercises, main-line wiring, source comparison, and the next lesson. Run the example before reading every function. Then change one invariant and use the test to discover what depends on it.

## Source Grounding and Scope

All source-trace links are pinned to [`earendil-works/pi` commit `2f5066d7`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/), corresponding to the 0.79.1 source snapshot used when the course was written. The zero-to-one teaching structure also credits [`shareAI-lab/claw0` commit `0090e863`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/). No local reference clone is required.

The course intentionally does not implement a terminal UI, dynamic extension imports, package installation, context compaction, hot reload, multimodal messages, provider usage accounting, automatic retries, or a process/container sandbox. s14 implements one OpenAI-compatible adapter directly so the protocol translation stays visible; production systems should normally use a maintained provider library and a broader conformance suite.

## Project Structure

```text
learn-pi-agent/
  README.md / README.zh.md / README.ja.md
  .env.example
  package.json
  s01_agent_loop/
  ...
  s13_integrated_harness/
  s14_real_provider/
```

## What You Should Be Able to Explain at the End

- Why streamed provider events carry richer invariants than a completed string.
- Why tool schemas, handlers, hooks, and execution environments are separate boundaries.
- How an append-only branchable session changes recovery and auditability.
- Why project trust is not a sandbox.
- Why runtime modes should own presentation but not agent state.
- How the same s13 loop works with deterministic fixtures and a real s14 provider.

The goal is not merely to make the demo answer. It is to be able to point at every boundary between model, provider, loop, tool, session, and shell, and explain what would break if that boundary moved.

The repository is licensed under the root [MIT License](../LICENSE).

**Keep the kernel small. Keep the events legible. Let the model decide, and make every harness boundary explicit.**
