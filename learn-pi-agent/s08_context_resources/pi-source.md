# s08 against the Pi 0.79.1 source

s08 maps to Pi's Resource Loader, Skill and Prompt Template parsers, and System Prompt construction.

```text
resource paths -> loaded resources -> system prompt / Harness resources -> TurnState
```

## Corresponding files

- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/system-prompt.ts)
- [`packages/coding-agent/src/core/skills.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/skills.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/agent/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/types.ts)

## The mapping

| s08 | Pi 0.79.1 |
| --- | --- |
| `createFileSystemResourceSource()` | filesystem access inside `DefaultResourceLoader` |
| `loadProjectContextFiles()` | project Context discovery in `resource-loader.ts` |
| `ContextFile` | Agent file path and content |
| `ContextSkill` | teaching combination of coding-agent Skill metadata and loaded body |
| `ContextPromptTemplate` | `PromptTemplate` |
| `formatPromptTemplateInvocation()` | Prompt Template argument substitution |
| `buildContextSystemPrompt()` | the Context File and Skill portions of `buildSystemPrompt()` |
| `prepareContextResources()` | loaded Resources feeding `AgentHarnessResources` and System Prompt |
| `runContextResourceTurn()` | course composition into the existing Harness turn |

## Context File order and provenance

Pi checks the configured agent directory first, then ancestor directories from root toward the working directory. In each directory it chooses the first supported AGENTS or CLAUDE filename. The course follows the same order through a `ResourceSource`.

Both implementations keep the file path alongside its content and include that path in the `project_instructions` wrapper. The prompt can therefore distinguish global, workspace, and nearer project instructions.

## Skills and Prompt Templates

Pi advertises Skills in the System Prompt only when the read Tool is available, because a Skill body is meant to be read from its file when relevant. The course also recognizes its teaching Tool name, `read_file`, and filters Skills marked `disable-model-invocation`.

The course's `ContextSkill` carries the parsed body for inspection, but only Skill metadata enters `harnessResources`. Prompt Template replacement matches Pi's one-pass rule: placeholders inside substituted argument values are not expanded a second time.

## Turn integration

Pi's Resource Loader owns discovery and reload; its result is passed into System Prompt construction and Harness Resources. `AgentHarness.createTurnState()` then snapshots those values with the selected Tools.

s08 uses the same ownership split. `prepareContextResources()` produces the prompt callback and Resources, while `runContextResourceTurn()` delegates model and Tool progression to the s06 Harness path.

## Course scope

The real Resource Loader also resolves packages and settings, tracks diagnostics and source metadata, applies project trust, loads Extensions and Themes, merges additional paths, and supports reload.

The lesson keeps real filesystem reads for Context Files and accepts Skill and Prompt Template paths explicitly. A missing Skill description is an error in the course; Pi reports a diagnostic and skips the invalid Skill.

## Suggested reading order

1. Start with `loadProjectContextFiles()` in `resource-loader.ts`.
2. Read the Context File and Skill sections of `buildSystemPrompt()`.
3. Follow Skill parsing and `formatSkillsForPrompt()` in `skills.ts`.
4. Read Prompt Template parsing and argument substitution.
5. Finish at `AgentHarness.createTurnState()` to see loaded Resources enter a Turn snapshot.
