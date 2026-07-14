# s11 · Project Trust

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the loading gate for project-local settings, resources, packages, and extensions before the Agent Session starts.

```text
project files
  -> detect trust inputs
  -> resolve one project-trusted decision
       +-> first Context candidate in each directory - outside trust gate
       +-> project settings / skills / extensions --- trusted only
       +-> project prompts / packages --------------- trusted only
  -> configure the same MiniCoreRuntime
```

## The problem

s10 gives one Agent runtime several shells. Before any shell starts, the Harness still has to decide which files from the working tree may change that runtime.

A project can contain settings, executable Extensions, Prompt Templates, Skills, and package declarations. Loading all of them silently would let a newly opened repository change Agent behavior. Refusing every project file would also be wrong: `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` are Context candidates that Pi handles independently of the trust decision. In each directory, the first existing candidate in that order wins.

The key is to draw one narrow boundary: Project Trust decides which project-local inputs may load. It does not decide what Tools may do after startup.

## The idea

s11 separates three questions that are easy to blur together:

| Question | Lesson mechanism |
| --- | --- |
| Does this project contain trust-sensitive input? | `hasProjectTrustInputs()` |
| Is the current project trusted? | `resolveProjectTrusted()` and `MiniTrustStore` |
| Which inputs may enter the runtime? | `loadProjectInputs()` and `createProjectTrustRuntime()` |

In this lesson, a current-directory `.pi/` tree or an `.agents/skills/` directory in the current directory or an ancestor triggers trust resolution. The four Context candidates do not trigger it.

After the decision, the loading rule is explicit:

| Input | Untrusted | Trusted |
| --- | --- | --- |
| first Context candidate per ancestor directory | load | load |
| current `.pi/settings.json` | skip | expose |
| ancestor `.agents/skills/**/SKILL.md` | skip | expose |
| current `.pi/extensions/**` | skip | expose |
| current `.pi/prompts/**/*.md` | skip | expose |
| current `.pi/packages/**` | skip | expose |

“Expose” matters. The lesson wires trusted Skill and Prompt paths into the real s10 runtime. It reports settings, Extension, and package paths so the loading decision remains inspectable, but does not parse settings, execute project Extensions, or install packages.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s11 -- "Summarize the project instructions that are available."
```

The default policy is `ask`. This compact CLI does not implement Pi's trust-selection UI, so protected project inputs stay off when there is no override or saved decision. Use the deterministic course switch to enable them:

```bash
PI_PROJECT_TRUST=always npm run s11 -- "List the project skills and prompt templates available to you."
```

The prompt still runs through the real Model, Session Tree, Context Resource loader, Extension Turn, and `read_file` Tool from earlier lessons. Trust changes only the project inputs supplied to that runtime.

## How the code works

### 1. Detect only inputs that require a trust decision

`hasProjectTrustInputs()` checks the current `.pi/` tree, then walks from the current directory to the filesystem root looking for `.agents/skills/`. Context files are deliberately absent from this trigger check.

`discoverProjectTrustFiles()` performs this discovery against the real filesystem for the CLI. Its result can also be passed directly to the public trust functions, so a host can inspect the same ancestor and loading rules before constructing a runtime.

### 2. Resolve one decision in a fixed order

`resolveProjectTrusted()` follows this precedence:

```text
explicit override
  -> no trust inputs: trusted
  -> Extension decision, optionally remembered
  -> nearest saved decision for cwd or an ancestor
  -> default policy: always / never / ask
  -> ask without UI: untrusted
  -> interactive prompt decision
```

`MiniTrustStore.get()` walks upward, so the closest saved parent decision applies. Unlike Pi's persistent `~/.pi/agent/trust.json`, the lesson store is in memory and lasts only as long as the current process.

### 3. Keep context outside the gate

`loadProjectInputs()` walks from the filesystem root toward the working directory regardless of trust. In each directory it selects the first existing file from `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`, matching s08 precedence. When trust is false, every protected collection is empty. When trust is true, the function returns the exact settings, Skill, Extension, Prompt, and package paths allowed by the lesson.

This is a loading distinction, not a claim that context is harmless. Project instructions are still untrusted text and should be reviewed when the repository itself is untrusted.

### 4. Configure the same real runtime

`createProjectTrustRuntime()` first prepares the trust decision, then adds trusted Skill and Prompt paths to `MiniCoreRuntime`. It does not replace the runtime or create a second Agent Core.

The existing Context Resource source continues to apply the same per-directory Context candidate precedence. The result is one cumulative Session whose available resources differ according to the gate.

## Try it yourself

1. Create a real project directory with no `.pi/` tree and no `.agents/skills/` in any ancestor. Pass its path to `discoverProjectTrustFiles()`, then pass the returned file map to `prepareProjectTrust()`. `projectTrusted` should be true because there is no protected input.
2. Add both `AGENTS.md` and `CLAUDE.md` to that directory and discover it again. Only `AGENTS.md` should appear in `projectInputs.contextFiles`, and the Context candidates should not change the trust decision.
3. Add `.pi/settings.json`, then compare `prepareProjectTrust()` with `defaultProjectTrust: "never"` and `"always"`. `projectSettingsLoaded` should switch from false to true. For the course working directory, `PI_PROJECT_TRUST=never npm run s11 -- "..."` and `PI_PROJECT_TRUST=always npm run s11 -- "..."` select those same policy branches.
4. Put `.agents/skills/review/SKILL.md` in the project or an ancestor and `.pi/prompts/review.md` in the project. Build with `createProjectTrustRuntime()` under both policies and compare `projectInputs`. After sending the same Prompt through each runtime, only the trusted runtime receives the Skill instructions and selected Prompt Template resource.
5. Save `true` for a real parent path and `false` for its child path in `MiniTrustStore`, then prepare the child project. The nearest saved decision should win while the selected Context file remains outside the gate.

## Wiring into the main line

| Boundary | s10 | s11 |
| --- | --- | --- |
| Runtime | one cumulative `MiniCoreRuntime` | the same runtime |
| Session | shared by all shells | still shared |
| Context | first matching candidate per directory | remains outside the Trust Gate |
| Project Skills and Prompts | caller-supplied paths | added only after trust |
| Settings, Extensions, packages | outside s10 | discovered and gated, not activated in this lesson |
| Decision state | none | override, Extension decision, nearest saved decision, or default |

## Against the Pi source

Pi 0.79.1 uses the same boundary: current `.pi/` and current-or-ancestor `.agents/skills/` cause trust resolution; the first matching `AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD` Context candidate in each directory loads independently; protected project settings, resources, packages, and Extensions load only after approval. Pi persists decisions and performs the real resource reload, package resolution, and Extension loading that this lesson leaves out.

Project Trust is not a permission system or sandbox. Pi's Tools and Extensions run with the permissions of the Pi process. The course `read_file` Tool's working-directory check is a teaching-tool policy, not a Pi security boundary and not a consequence of Project Trust. Strong isolation must come from an external container, VM, micro-VM, remote sandbox, or operating-system policy.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## Next up

[s12 · Pi Package](../s12_pi_package/) follows one protected input after trust: a package resolves into the same resource kinds the runtime already understands.
