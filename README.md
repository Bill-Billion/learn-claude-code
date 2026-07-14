[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# Learn Agent Harness: Build the System Around the Model

A capable model can reason about a task and choose an action. It still needs code that shows it the environment, offers tools, executes approved actions, keeps state, and reports the result. That surrounding system is the agent harness.

Learn Agent Harness teaches that system through three independent, runnable courses. You can build the loop directly in Python, follow the same loop through an event-driven TypeScript runtime, or use LangChain's framework abstractions. The implementations differ, but the engineering questions stay concrete: what does the model see, what may it do, what state survives, and how does the application know when to continue or stop?

## The Model Chooses; the Harness Makes the Choice Operational

An agent product combines learned capability with an operational environment:

```text
Agent product = trained model + harness

Harness = model adapter
        + tools and action interfaces
        + context and knowledge
        + state and memory
        + permissions and trust boundaries
        + runtime, observation, and recovery
```

The model interprets an unfamiliar request and decides what to do next. The harness turns that decision into a controlled operation. It translates provider responses, dispatches tools, records results, limits access, and prepares the next model call.

Prompt chains, state graphs, and workflow engines belong on the harness side of this boundary. They are useful when a process needs explicit routing, persistence, retries, or approval. They organize the use of a trained model; they do not replace the model's judgment.

| Responsibility | Model | Harness |
| --- | --- | --- |
| Understand intent and incomplete information | Primary | Supplies relevant context |
| Choose a response or tool call | Primary | Defines the available actions |
| Execute a command or API call | Requests it | Runs it under policy |
| Preserve sessions and long-running work | Uses the supplied history | Stores, compacts, and restores state |
| Enforce permissions | Cannot be the trust boundary | Validates, asks for approval, and isolates execution |
| Observe failures and continue | Reasons about the failure | Captures errors, retries safely, and exposes evidence |

## One Agent Loop, Three Ways to See It

Every course returns to the model-tool loop:

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

Streaming, hooks, memory, task queues, graphs, and multi-agent coordination all attach around this loop. They change how the application observes and manages a turn. The model still selects the next semantic action; the harness still owns execution and policy.

### What each course reveals

| View | Course | What stays visible | What you learn to reason about |
| --- | --- | --- | --- |
| Direct implementation | [Learn Claude Code](./learn-claude-code/) | The loop, handler maps, context, persistence, teams, and goal checks | How a coding harness grows one mechanism at a time |
| Event-driven runtime | [Learn Pi Agent](./learn-pi-agent/) | Typed provider events, turn state, sessions, extensions, and trust decisions | How a runtime separates protocol, core, and product shell |
| Framework abstraction | [Learn LangChain](./learn-langchain/) | Models, messages, prompts, tools, agents, middleware, retrieval, and RAG | What the framework accepts, returns, and coordinates for you |

Together, the courses prevent two common blind spots. A framework-only view can hide state transitions that matter during debugging. A from-scratch-only view can leave you rebuilding stable abstractions instead of using them deliberately.

## Choose a Course

| Course | Best starting point for | Stack | Lessons | Languages | Live model path |
| --- | --- | --- | ---: | --- | --- |
| [Learn Claude Code](./learn-claude-code/) | First-principles harness engineering and coding-agent architecture | Python 3.11 | 22 | English, Chinese, Japanese | Anthropic-compatible API |
| [Learn Pi Agent](./learn-pi-agent/) | TypeScript developers studying protocols and event-driven runtimes | Node.js 22.19+ + TypeScript | 13 | English, Chinese, Japanese | OpenAI-compatible API from s01 |
| [Learn LangChain](./learn-langchain/) | Python developers who want to build with LangChain while understanding its contracts | Python 3.11 + uv | 13 | Chinese | OpenAI by default |

The courses do not share runtime dependencies. Install only the course you are studying.

## Quick Start

Clone the repository once, then enter the course you want to study. The course-specific commands in the next three sections all start from the repository root.

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness
```

## Course 1: Learn Claude Code

[Learn Claude Code](./learn-claude-code/) reconstructs a coding harness in 22 progressive Python lessons. It begins with one model-tool loop and keeps that loop recognizable while adding the machinery needed for longer, safer, collaborative work.

### Who it is for

Choose this course when you want to inspect agent mechanics without a framework owning the main control flow. It suits Python developers, coding-agent users who want to understand the product beneath the interface, and engineers designing a harness for another domain.

After the course, you should be able to separate model decisions from runtime responsibilities, add tools without rewriting the loop, manage finite context, persist work, coordinate subagents, and close a task against trusted evidence.

### What the 22 lessons build

| Lessons | Layer added to the harness |
| --- | --- |
| s01-s04 | Agent loop, tool dispatch, permissions, and hooks |
| s05-s11 | Planning, subagents, skills, context compaction, memory, prompts, and recovery |
| s12-s14 | Persistent tasks, background work, and scheduling |
| s15-s18 | Teams, coordination protocols, autonomous claiming, and worktree isolation |
| s19-s22 | MCP, complete integration, workflow runtime, and goal-based continuation |

The current 22-lesson track is the recommended path. The course also retains a legacy 12-lesson track for existing readers; the [course directory](./learn-claude-code/) contains guides that explain the mapping.

### Run it

```bash
cd learn-claude-code
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY before the live run.
python s01_agent_loop/code.py
```

The runnable chapter uses the provider settings in `.env`. The course guide also documents its generated Web learning interface.

- [English course guide](./learn-claude-code/README.md)
- [中文课程指南](./learn-claude-code/README.zh.md)
- [日本語コースガイド](./learn-claude-code/README.ja.md)

## Course 2: Learn Pi Agent

[Learn Pi Agent](./learn-pi-agent/) builds a small Pi-style runtime in 13 cumulative TypeScript lessons. From s01, a real model can call a safe, read-only tool and use its result in the next response. The following lessons keep that loop recognizable while adding provider events, tool lifecycle handling, turn state, sessions, context resources, extensions, runtime modes, trust checks, and package resolution. s13 integrates the complete harness on the same provider path.

### Who it is for

Choose this course when typed boundaries and runtime events help you understand a system. It suits TypeScript developers, CLI and SDK authors, and readers who want to see how the protocol layer, agent core, and product shell remain separable.

After the course, you should be able to design a swappable provider contract, normalize streaming events, expose lifecycle hooks without changing the core loop, preserve session branches, and place execution policy outside model output.

### What the 13 lessons build

| Lessons | Layer added to the harness |
| --- | --- |
| s01-s03 | Real model-tool loop, tool schemas, and normalized provider events |
| s04-s06 | Lifecycle-aware tool execution, hooks, and turn state |
| s07-s09 | Session trees, context resources, and extension runtime |
| s10-s12 | Runtime modes, project trust, and package resolution |
| s13 | One integrated harness running the same real provider path |

The chapter commands use a real provider from s01 onward. Exact wording and tool choices can vary between runs; the model-tool loop, event protocol, and state contracts are the parts to inspect.

### Run it

```bash
cd learn-pi-agent
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY.
npm run s01
```

`OPENAI_MODEL` defaults to `gpt-4o-mini`, and `OPENAI_BASE_URL` defaults to the official OpenAI API. Continue with `npm run s02` through `npm run s13`. Because the model chooses the response and tool call, typical output may differ from the examples.

- [English course guide](./learn-pi-agent/README.md)
- [中文课程指南](./learn-pi-agent/README.zh.md)
- [日本語コースガイド](./learn-pi-agent/README.ja.md)

## Course 3: Learn LangChain

[Learn LangChain](./learn-langchain/README.md) is a 13-lesson Chinese course for learning LangChain through its current public APIs. Each lesson adds one abstraction and keeps its input and output types visible. The path moves from a direct model call to messages, prompts, structured output, tools, agents, memory, retrieval, and a small RAG application.

### Who it is for

Choose this course when you want to build a LangChain application without treating the framework as a black box. It suits Python beginners who have basic language experience and application developers who need a practical route into agents and RAG.

After the course, you should be able to select the right LangChain component, predict its input and return type, trace the message state through an agent, and decide which parts of a RAG flow belong in retrieval, tools, or model context.

### What the 13 lessons build

| Lessons | Layer added to the application |
| --- | --- |
| s01-s05 | Model invocation, messages, system prompts, templates, and structured output |
| s06-s10 | Tools, agents, streaming, short-term memory, and todo middleware |
| s11-s13 | Retrieval basics, minimal RAG, and an integrated course assistant |

The main path stays focused on LangChain. Deep LangGraph orchestration, MCP, multi-agent systems, and production vector databases remain follow-up topics rather than hidden prerequisites.

### Run it

```bash
cd learn-langchain
uv sync --locked
cp .env.example .env
# Edit .env and set OPENAI_API_KEY before the live run.
uv run python -m s01_first_model.code
```

Examples read `LANGCHAIN_MODEL` and provider credentials from `.env`; the default configuration uses OpenAI. Lessons s11-s13 also use OpenAI embeddings unless you inject another embedding implementation.

- [中文课程指南](./learn-langchain/README.md)

## Pick a Learning Route

### Understand the architecture from first principles

Study Claude Code first, then Pi Agent, and finish with LangChain. You will see a direct implementation before comparing an event protocol and a framework. This is the most complete route through the repository.

### Build a TypeScript runtime

Start with Pi Agent. Compare s03-s06 with Claude Code s01-s04 when you want to contrast event normalization with a direct request loop. Continue into the Claude Code chapters on context, tasks, and teams when your runtime needs longer-lived work.

### Build an agent or RAG application now

Start with LangChain and complete its 13-lesson main line. Then read the first four lessons of either implementation course. The second pass gives names and code paths to the work that `create_agent` coordinates for you.

### Compare one engineering concern

Use the courses as three views of the same design problem:

| Concern | Learn Claude Code | Learn Pi Agent | Learn LangChain |
| --- | --- | --- | --- |
| Model boundary | Anthropic content blocks and `stop_reason` | Provider contract and normalized events | `init_chat_model` and message objects |
| Tool boundary | JSON schemas and handler dispatch | Typed schemas, events, and execution hooks | `@tool` and agent-managed tool messages |
| Turn state | `messages` plus explicit runtime state | Event stream and `TurnState` | Agent state and message history |
| Extension | Hooks, skills, and MCP | Hooks, extensions, and packages | Middleware and composable components |
| Context | Skills, memory, and compaction | Context resources and session branches | Prompts, checkpointers, and retrieval |
| Control | Permissions, tasks, workflows, and goals | Trust checks and runtime modes | Agent orchestration and middleware |

## How to Work Through a Course

1. Read the course guide and run the first lesson before changing code.
2. Work through one lesson directory at a time. Identify the mechanism added since the previous lesson.
3. Run the chapter entry point and inspect the state or events it emits.
4. Change one boundary: add a tool, reject an action, branch a session, or change a context resource.
5. Run the lesson again, then compare the implementation with the next chapter.

The runnable examples are the main learning path. Their exact wording can vary, so compare the model-tool loop, events, and state rather than a fixed transcript. Each course has its own environment and lock file; there is no root-level install command.

## Repository Layout

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── CONTRIBUTING.md
├── LICENSE
├── .github/workflows/       # independent course checks and repository hygiene
├── learn-claude-code/       # 22 Python lessons, trilingual
├── learn-pi-agent/          # 13 TypeScript lessons, trilingual
└── learn-langchain/         # 13 Python lessons, Chinese
```

Dependency directories, generated sites, caches, local source clones, internal plans, and model workspace files do not belong in the published tree.

## Repository Boundaries

- Lessons expose one mechanism at a time. They are teaching implementations, not production SDKs.
- Later lessons may integrate earlier code, but each course keeps its own dependencies and checks.
- Live examples may need a paid provider account.
- The Claude Code and Pi Agent courses keep English, Chinese, and Japanese guides synchronized. Learn LangChain currently publishes Chinese material only.
- Simplified permissions, storage, or provider adapters are named as such instead of being presented as production-complete systems.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Changes to lesson counts, commands, provider behavior, or course scope must update all three root README files. Changes inside a trilingual course must keep its three course guides aligned.

Run the checks for every course you touch and keep generated output, dependency directories, local references, drafts, and internal planning material out of commits.

## License

[MIT](./LICENSE)
