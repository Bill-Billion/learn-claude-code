[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# Learn Agent Harness

Build the systems around capable models, one working layer at a time.

Learn Agent Harness is a three-course monorepo for understanding how agent products are assembled. Instead of hiding behavior behind one large framework, each course exposes the loop, tools, state, context, permissions, and runtime decisions that make a model useful in a real environment.

## Choose a Course

| Course | What you build | Stack | Lessons | Languages | Model access |
| --- | --- | --- | ---: | --- | --- |
| [Learn Claude Code](./learn-claude-code/) | A Claude Code-style coding harness, from one loop to goals and multi-agent workflows | Python | 22 | English, Chinese, Japanese | Anthropic API for live examples; tests are offline |
| [Learn Pi Agent](./learn-pi-agent/) | A small, event-driven Pi-style harness with sessions, extensions, trust boundaries, and packages | TypeScript | 13 | English, Chinese, Japanese | Fully deterministic and offline |
| [Learn LangChain](./learn-langchain/) | Model, prompt, tool, agent, memory, LangGraph, and RAG patterns in one progressive course | Python | 13 | Chinese | OpenAI for live examples; tests are offline |

Each course is self-contained. You can study one without installing the dependencies of the other two.

## Pick a Learning Route

### From first principles

Start with **Learn Claude Code** to see the smallest possible agent loop grow into a complete coding harness. Continue with **Learn Pi Agent** to compare an event-driven TypeScript design, then use **Learn LangChain** to map those primitives onto framework abstractions.

### TypeScript and runtime design

Start with **Learn Pi Agent**. Its deterministic provider makes every event and state transition inspectable. Compare the result with Claude Code's direct Python implementation when you want to study permissions, compaction, tasks, and multi-agent coordination.

### Frameworks, graphs, and RAG

Start with **Learn LangChain** if your immediate goal is application development. Then read either implementation course to understand what the framework is coordinating underneath.

### Architecture comparison

Read the same concerns across all three courses: model adaptation, tool dispatch, turn state, persistence, context control, extension points, and trust boundaries. The names differ; the engineering questions repeat.

## What Is an Agent Harness?

A useful agent product combines two different things:

```text
Agent product = trained model + harness

Harness = model adapter
        + tools
        + context and knowledge
        + state and memory
        + permissions
        + runtime and observation
```

The model supplies learned capabilities. The harness gives those capabilities a place to operate: it presents observations, exposes actions, records state, enforces boundaries, and decides what happens around each model call.

Prompt chains, orchestration libraries, and state graphs can all be valid harness tools. They help structure control flow and application state. They do not create agency by themselves; they organize how a trained model is used.

## The Shared Loop

All three courses eventually return to the same provider-neutral loop:

```text
messages = [user_request]

while true:
    response = model(messages, tools)
    messages += response

    if response has no tool calls:
        break

    for call in response.tool_calls:
        result = run_tool_with_policy(call)
        messages += result
```

Real products add streaming, hooks, retries, compaction, persistence, scheduling, teams, or graphs. The loop remains the point where model intent meets harness behavior.

## The Courses

### Learn Claude Code

Twenty-two incremental Python lessons reconstruct a coding agent from a minimal loop. The course covers tool use, permissions, hooks, subagents, skill loading, context compaction, memory, recovery, tasks, scheduling, agent teams, worktree isolation, MCP, workflow runtimes, and persistent goals.

- [English course guide](./learn-claude-code/README.md)
- [中文课程指南](./learn-claude-code/README.zh.md)
- [日本語コースガイド](./learn-claude-code/README.ja.md)

### Learn Pi Agent

Thirteen TypeScript lessons build a mini Pi-style harness with a swappable provider contract. The course emphasizes event streams, session trees, context resources, extensions, trust boundaries, package resolution, and integration. Every example and test runs without a model key.

- [English course guide](./learn-pi-agent/README.md)
- [中文课程指南](./learn-pi-agent/README.zh.md)
- [日本語コースガイド](./learn-pi-agent/README.ja.md)

### Learn LangChain

Thirteen Chinese Python lessons progress from direct model calls to prompts, structured output, tools, agents, middleware, memory, retrieval, LangGraph, and a comprehensive project. Starter files, completed implementations, and offline tests make the abstractions concrete.

- [中文课程指南](./learn-langchain/README.md)

## Repository Layout

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── CONTRIBUTING.md
├── LICENSE
├── learn-claude-code/
├── learn-pi-agent/
└── learn-langchain/
```

Course dependencies, generated sites, local source clones, and internal planning material are intentionally not committed.

## Get Started

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness
```

Then enter one course and follow its guide:

```bash
cd learn-claude-code   # Python, 22 lessons
cd learn-pi-agent      # TypeScript, 13 lessons
cd learn-langchain     # Python, 13 lessons
```

The commands above are alternatives from the repository root, not a sequence.

## Repository Principles

- **Expose the mechanism.** Teaching code should make the state transition visible.
- **Change one idea at a time.** Later lessons build on earlier ones without turning each chapter into a production framework.
- **Test the boundary.** Course checks are deterministic and do not require paid model calls.
- **Name simplifications honestly.** Each course distinguishes teaching shortcuts from production behavior.
- **Keep translations synchronized.** When a trilingual lesson changes, its code blocks and technical claims change together.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

[MIT](./LICENSE)
