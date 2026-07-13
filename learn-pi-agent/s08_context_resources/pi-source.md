# Pi Source Map for s08

s08 corresponds to Pi's context resources.

```text
resource loader
  -> context files / skills / prompt templates
  -> build system prompt
  -> createTurnState()
```

## Files

- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/system-prompt.ts)
- [`packages/coding-agent/src/core/skills.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/skills.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)

Specific anchors:

```text
resource-loader.ts:61-77       finding AGENTS.md / CLAUDE.md in a directory
resource-loader.ts:79-117      global + ancestor-directory order in loadProjectContextFiles()
resource-loader.ts:261-283     getSkills() / getPrompts() / getAgentsFiles()
resource-loader.ts:333-425     reload() parsing extensions, skills, prompts
system-prompt.ts:8-25          BuildSystemPromptOptions
system-prompt.ts:60-74         appending context files and skills under a custom prompt
system-prompt.ts:153-166       appending context files and skills under the default prompt
agent-harness.ts:331-362       createTurnState() reads resources and produces the systemPrompt
agent-harness.ts:981-995       getResources() / setResources()
harness/types.ts:46-78         Skill, PromptTemplate, AgentHarnessResources
harness/types.ts:804-820       AgentHarnessOptions.resources and the systemPrompt callback
```

## Mapping

| s08 | Pi |
| --- | --- |
| `MemoryFiles` | the local filesystem plus settings/package manager |
| `loadContextResources()` | `DefaultResourceLoader.reload()` |
| `loadProjectContextFiles()` | `loadProjectContextFiles()` |
| `ContextSkill` | `Skill` |
| `ContextPromptTemplate` | `PromptTemplate` |
| `formatSkillsForSystemPrompt()` | `formatSkillsForPrompt()` / `formatSkillsForSystemPrompt()` |
| `buildContextSystemPrompt()` | `buildSystemPrompt()` |
| `createContextResourceTurnState()` | `AgentHarness.createTurnState()` |

## Why this section doesn't scan real directories

Real Pi pulls resources from many places:

```text
~/.pi/agent/AGENTS.md
AGENTS.md / CLAUDE.md in parent directories and the current directory
~/.pi/agent/skills
.pi/skills
.agents/skills
~/.pi/agent/prompts
.pi/prompts
pi package
resource paths added dynamically by extensions
temporary CLI paths
```

If s08 replicated all of these paths from the start, the reader would get dragged into file-scanning details. The teaching code simulates resource input with explicit paths instead, keeping only Pi's core boundary:

```text
context files go into the system prompt
skills enter the system prompt as an index first
prompt templates wait for explicit invocation
the harness takes a resources snapshot every turn
```

## An easy thing to mix up

`AgentHarnessResources` has only two kinds:

```text
skills
promptTemplates
```

Context files like `AGENTS.md` are stitched into the system prompt in the coding-agent outer layer — they are not a field of `AgentHarnessResources`.

s08's `ContextResourceTurnState` returns an extra `contextFiles` only so the demo and tests can see them. In real Pi, context files reach `systemPrompt` through `buildSystemPrompt()`.

## What s08 doesn't do yet

s08 does not implement any of this:

```text
project trust
resource diagnostics
settings manager
package manager
extension resources_discover
theme loading
real filesystem scanning
full YAML frontmatter
advanced prompt template placeholders (bash-style syntax like ${N:-default} and ${@:N})
```

The placeholder substitution itself is already aligned with Pi: a single pass, and `$1`, `$@`, `$ARGUMENTS` inside argument values are never expanded a second time (the comment at Pi's `prompt-templates.ts:67` states this property explicitly).

Two behavioral differences to know: when a skill lacks a description, mini throws outright, while Pi logs a warning diagnostic and skips that skill, continuing to load (`skills.ts:290-307`); also, the coding-agent-level `Skill` type has no content field (`skills.ts:74-81` — bodies are read on demand by the model), only the harness-level `Skill` has content — mini's `ContextSkill` carries content but strips it before handing off to the harness.

The rest gets covered separately later. s08 answers one question only: besides session messages, what project resources does a turn need?

## Suggested reading path

Start with `loadProjectContextFiles()` in `resource-loader.ts` to confirm the loading order of `AGENTS.md` and `CLAUDE.md`.

Then read `system-prompt.ts`, and notice that skills are only appended to the prompt when the `read` tool is available.

Finish with `createTurnState()` in `agent-harness.ts`. It doesn't scan files — it only reads the already-prepared resources and hands them to the system prompt callback.
