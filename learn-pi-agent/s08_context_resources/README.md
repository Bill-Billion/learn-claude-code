# s08 · Context Resources

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the coding-agent Resource Loader and System Prompt builder that feed Context Files, Skills, and Prompt Templates into the Harness.

```text
filesystem source -> context files + skills + prompt templates
                                  |
                                  +-> system prompt + TurnState resources -> real Harness Turn
```

## The problem

A Tool Loop is not enough to work inside a repository. The model also needs project instructions, a list of specialized Skills it can read when relevant, and reusable Prompt Templates.

Hard-coding that material into the Agent Loop mixes product policy with execution. Reading every possible file into every request wastes Context and makes provenance difficult to explain. Resources need a separate loading boundary.

## The idea

s08 introduces three Resource types:

```text
ContextFile     project instructions inserted into the System Prompt
ContextSkill    name, description, file location, and body loaded from a Skill file
PromptTemplate  reusable Prompt text with positional argument substitution
```

A `ResourceSource` supplies text. The production lesson entry uses `createFileSystemResourceSource()`, which reads real files. `prepareContextResources()` converts loaded Resources into the s06 Harness shape and a dynamic System Prompt.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s08
```

Or send one prompt directly:

```bash
npm run s08 -- "Use read_file to inspect the repository README and follow its project instructions."
```

The CLI reads Context Files from the actual filesystem, takes a Turn snapshot, and runs the same real `read_file` loop. Model wording and Tool choices can vary. Explicit Skill and Prompt Template paths are available through the API and are exercised separately from the default CLI configuration.

## How the code works

### 1. Load Context Files from a real source

`createFileSystemResourceSource()` wraps `readFile(path, "utf8")` and treats only a missing file as absent. `loadProjectContextFiles()` checks the agent directory first, then each ancestor from filesystem root down to `cwd`.

For each directory, the first existing candidate wins:

```text
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

The returned `ContextFile` keeps both its path and content, so the System Prompt can show where each instruction came from.

### 2. Parse Skills and Prompt Templates

Skill and Prompt Template paths are explicit inputs. `loadSkill()` parses the small frontmatter block, requires a description, and keeps the body plus file path. A Skill with `disable-model-invocation: true` is loaded but not advertised to the model.

`loadPromptTemplate()` derives its name from the filename and keeps its body. `formatPromptTemplateInvocation()` expands `$1`, `$2`, `$@`, and `$ARGUMENTS` in one pass, so placeholder-looking text inside an argument is not expanded again.

### 3. Build the System Prompt at snapshot time

`buildContextSystemPrompt()` adds the current working directory and wraps each Context File in a path-labelled `project_instructions` block. It lists model-visible Skills only when `read` or `read_file` is active, because the model must be able to open the referenced file.

`prepareContextResources()` returns:

```ts
{
  contextResources, // full loaded values for the product layer
  harnessResources, // Skill and Prompt Template metadata for TurnState
  systemPrompt,     // callback resolved with the active Tool set
}
```

This keeps Resource loading outside the Agent Loop while still making the final prompt depend on the current Turn.

### 4. Run the same real Harness Turn

`runContextResourceTurn()` prepares Resources and calls `runHarnessTurn()` with the resulting System Prompt and Harness Resources. It does not create another Loop.

The live path therefore remains:

```text
filesystem Context -> TurnState -> model -> read_file -> Tool Result -> model
```

User, Assistant, and Tool Result Messages are still persisted through the s07 Session Tree.

## Try it yourself

1. Add an `AGENTS.md` in a parent directory and a `CLAUDE.md` in the working directory. Inspect `contextResources.contextFiles` and the System Prompt order.
2. Pass a Skill file with `disable-model-invocation: true`, then remove the flag. Compare the loaded Skill list with the `available_skills` block.
3. Load a Prompt Template containing `Fix $1 with focus on $@` and call `formatPromptTemplateInvocation()` with two arguments.

## Wiring into the main line

| Boundary | s07 | s08 |
| --- | --- | --- |
| Session Context | active `AgentMessage[]` | the same active history |
| Project instructions | none | filesystem-backed Context Files |
| Specialized guidance | none | explicit Skill files advertised on demand |
| Reusable prompts | none | Prompt Templates with one-pass substitution |
| System Prompt | generic or caller-provided | built from `cwd`, active Tools, Context Files, and Skills |
| Live execution | Session Tree plus `runHarnessTurn()` | the same path with prepared Resources |

## Against the Pi source

Context-file order, path-labelled System Prompt sections, Skill visibility, and Prompt Template substitution map to Pi 0.79.1. The lesson uses explicit Skill and Prompt paths rather than rebuilding Pi's package resolution, diagnostics, trust, and reload machinery.

See [pi-source.md](pi-source.md) for the pinned mapping.

## Next up

[s09 · Extension Runtime](../s09_extension_runtime/) lets external factories register Tools, Commands, and Events, and lets extensions contribute Resource paths with provenance.
