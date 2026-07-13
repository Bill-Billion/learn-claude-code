# s08 · Context Resources

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s07](../s07_session_tree/README.md) · [Contents](../README.md) · [s09 →](../s09_extension_runtime/README.md)

> In one sentence: before a turn starts, Pi gathers up the project's manuals — three kinds of resources (AGENTS.md, skills, prompt templates), three different ways into the request.
>
> Where this sits in Pi: the resource-loading layer of `@earendil-works/pi-coding-agent` — resource loader plus system prompt, sitting in front of the harness's `createTurnState()`.

→ AGENTS.md goes into the system prompt in full, a skill exposes only its name, description, and path, and a prompt template doesn't go in at all — it waits for the user to type `/name`
→ No read tool this turn? Then the model doesn't get the skill list at all: every item on it is a file path the model would have to go read itself
→ Placeholder substitution makes exactly one pass; `$1` and `$ARGUMENTS` inside argument values stay as-is — recursive expansion would turn user input into a template injection point
→ Resource discovery is the outer application's job; each turn, the harness just receives one tidied-up snapshot

---

## The problem

The s06 turn state can already snapshot a turn's inputs, and s07 answered where messages come from — the current branch of the session tree. But with only that, the model still knows nothing about the project: not the repo's conventions, not the ready-made playbooks, not the prompt templates the user has collected.

A real repo usually holds things like these:

```text
AGENTS.md                  project notes and conventions
.pi/skills/review/SKILL.md a step-by-step playbook for a certain kind of task
.pi/prompts/fix.md         a prompt template the user expands by hand
```

The lazy approach is to treat them all the same: read everything and paste the full text into the system prompt. The problems show up immediately — a skill can run hundreds of lines, and the model would carry it every turn; a prompt template exists for when the user types `/fix`, so why should the model stare at it every turn; and as resources pile up, the system prompt only gets more bloated.

So the real question is: three kinds of resources — in what form, and at what moment, should each one enter a turn?

## The idea

Pi gives the three kinds three different treatments:

| Resource | How it enters | Who reads the body |
| --- | --- | --- |
| context files (AGENTS.md / CLAUDE.md) | full text concatenated into the system prompt | the model, every turn |
| skills | name + description + path go into the system prompt | the model reads on demand with read, once it decides the task matches |
| prompt templates | stored in resources only, never in the system prompt | expanded when the user types `/fix README.md` |

Plus one linkage rule: the skill list only appears when the current turn has a `read` tool. The list is nothing but file paths — if the model can't read files, handing it the list is pointless.

This section doesn't cover real file scanning, project trust and the pi package, or extensions registering resources dynamically — those belong to s11, s12, and s09 respectively. Resource paths are given explicitly by the caller, and the filesystem is simulated with an in-memory object.

## Run it first

```sh
npm run session:s08
```

The output looks like this:

```text
Session: demo-session
Context files: AGENTS.md, AGENTS.md
Skills in resources: review
Prompt templates: fix
System prompt has skills: true
Template expansion: Fix README.md and explain the verification.
```

The two `AGENTS.md` on the second line aren't a double load — they're two files: the demo only prints basenames; one comes from the global agent directory `/home/me/.pi/agent/AGENTS.md`, the other from the project root `/work/pi/AGENTS.md`.

`System prompt has skills: true` because this turn's activeTools include `read`. The last line is the expansion of `/fix README.md` — the `$1` in the template became `README.md`.

## How the code works

### Three kinds of resources, stored separately

```ts
export function loadContextResources(options: LoadContextResourcesOptions): ContextResources {
  return {
    contextFiles: loadProjectContextFiles(options.files, options.cwd, options.agentDir),
    skills: (options.skillFiles ?? []).map((filePath) => loadSkill(options.files, filePath)),
    promptTemplates: (options.promptTemplateFiles ?? []).map((filePath) => loadPromptTemplate(options.files, filePath)),
  };
}
```

Skill and prompt template paths come from the caller; context files are found by directory rules. `MemoryFiles` is just a `Record<string, string>` — real Pi scans the local filesystem plus settings/package manager, but the teaching code pins the inputs down so the resource flow stays visible.

### AGENTS.md: global first, then the project

```ts
function loadProjectContextFiles(files: MemoryFiles, cwd: string, agentDir: string): ContextFile[] {
  const result: ContextFile[] = [];
  const seen = new Set<string>();

  const globalFile = findContextFile(files, agentDir);
  if (globalFile) {
    result.push(globalFile);
    seen.add(globalFile.path);
  }

  for (const dir of ancestorDirs(cwd)) {
    const file = findContextFile(files, dir);
    if (file && !seen.has(file.path)) {
      result.push(file);
      seen.add(file.path);
    }
  }

  return result;
}
```

Take the global copy first, then walk from the root directory down to cwd, picking up one file per level. The closer a file is to the project, the later it lands in the prompt — the last thing the model reads is the one nearest the current working directory.

`findContextFile` recognizes four names:

```ts
for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
```

`CLAUDE.md` counts too — that's Pi being compatible with conventions existing projects already have.

### A skill exposes only its name, description, and path

```ts
if (options.activeToolNames.includes("read")) {
  const skillsBlock = formatSkillsForSystemPrompt(options.skills);
  if (skillsBlock) {
    lines.push("", skillsBlock);
  }
}
```

The system prompt carries no skill bodies, just an `<available_skills>` index: name, description, file path. The model knows there's a `review` skill and knows where to read it, without hauling the full content every turn. The `read` check wrapping it is the linkage rule from earlier: when the model has no read tool, an index made entirely of paths means nothing, so it's simply withheld.

`formatSkillsForSystemPrompt()` also opens with a filter:

```ts
const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
```

A skill whose frontmatter says `disable-model-invocation: true` stays off the model-visible list, but can still be invoked explicitly.

### Placeholders get exactly one pass

```ts
export function formatPromptTemplateInvocation(template: ContextPromptTemplate, args: string[] = []): string {
  const allArgs = args.join(" ");
  // Single pass over the template, like Pi: argument values that contain
  // $1, $@, or $ARGUMENTS are NOT recursively substituted.
  return template.content.replace(/\$(ARGUMENTS|@|\d+)/g, (_match, token: string) => {
    if (token === "ARGUMENTS" || token === "@") return allArgs;
    return args[Number(token) - 1] ?? "";
  });
}
```

Three placeholders: `$1` is the first argument; `$@` and `$ARGUMENTS` are all of them.

The key is the single pass: whatever the `replace` callback returns is what lands, and the return value is never scanned by the regex a second time — so a `$1` or `$ARGUMENTS` inside an argument value survives into the result untouched. This property is worth defending. Say the template is `Fix $1 then $ARGUMENTS.` and the user happens to pass `$ARGUMENTS` and `$2` as arguments. Single-pass substitution yields `Fix $ARGUMENTS then $ARGUMENTS $2.` — the arguments land in the text verbatim, odd but harmless. If substitution were recursive, the `$ARGUMENTS` in that result would expand again, the `$2` would get replaced again, and the string would mutate on every pass — a string the user casually handed over becomes an injection point that can rewrite other parts of the template. Pi explicitly promises non-recursion in a comment in `prompt-templates.ts`, and mini holds the same line with a single `replace` pass.

### Plugging back into the s06 harness

```ts
const harness = createMiniHarness({
  session: options.session,
  model: options.model,
  registry: options.registry,
  activeToolNames: options.activeToolNames,
  resources: {
    skills: contextResources.skills.map(({ name, description }) => ({ name, description })),
    promptTemplates: contextResources.promptTemplates.map(({ name, description, content }) => ({
      name,
      description,
      content,
    })),
  },
  systemPrompt({ activeTools }) {
    return buildContextSystemPrompt({
      cwd: options.cwd,
      activeToolNames: activeTools.map((tool) => tool.name),
      contextFiles: contextResources.contextFiles,
      skills: contextResources.skills,
    });
  },
} satisfies MiniHarnessOptions);
```

s08 doesn't rewrite the harness. Before a skill goes into resources it gets stripped down to name and description — s06's `MiniSkill` has exactly those two fields, and the body and path stay in s08's own hands; a prompt template goes in with name, description, and content. Context files don't travel through resources at all — they go through the `systemPrompt` callback and get assembled into the final prompt together with the turn's activeTools.

Resource discovery — scanning files, reading AGENTS.md, parsing skill frontmatter — is the outer application's work; the harness only receives one tidied-up resources object. The three kinds enter the request in three different ways: AGENTS.md in full, skills as an entry point only, templates waiting for the user to expand them — but all of them arrive through the same turn state snapshot. This is the boundary where Pi separates mechanism from policy: the harness provides the mechanism, and how resources are found and what the model gets to see is the outer layer's policy.

## Try it yourself

All of the demo's inputs live in `runDemo()`; after changing them, just rerun `npm run session:s08`:

1. Play with placeholders: change the body of `/work/pi/.pi/prompts/fix.md` in `files` to `Fix $1 then $ARGUMENTS.`, and change the `["README.md"]` passed at expansion time to `["$ARGUMENTS", "$2"]`. The output should be `Fix $ARGUMENTS then $ARGUMENTS $2.` — placeholders inside arguments preserved as-is. Then build the recursive counterexample: feed the first pass's result back in as a template, `formatPromptTemplateInvocation({ ...promptTemplate, content: firstPassResult }, sameArgs)`, and watch the string change shape again. That's exactly what single-pass substitution is guarding against.
2. Add a `"/work/AGENTS.md": "Workspace instruction."` to `files` — the demo's cwd is `/work/pi`, and `/work` is its parent directory. After a rerun, `Context files` shows three `AGENTS.md`, ordered global → `/work` → `/work/pi`.
3. Change `activeToolNames: ["read", "bash"]` to `["bash"]`. `System prompt has skills` becomes `false` — the skill is still in resources, it just isn't shown to the model this turn.

After changing things, run `npm run test:s08` to confirm you haven't broken this section's behavioral contract.

## Wiring into the main line

s08 plugs into the s06 harness and fills in the resources slot that's been sitting empty:

| Component | Last section (s07) | This section (s08) |
| --- | --- | --- |
| messages | the session tree's current branch via `buildContext()` | unchanged — the session provides them as before |
| system prompt | s06's fixed default | assembled dynamically each turn from context files and activeTools |
| resources | empty | skills and prompt templates enter the snapshot |
| turn state | s06's `TurnState` | `ContextResourceTurnState`, adding a `contextFiles` field |

## Against the Pi source

Read [pi-source.md](pi-source.md) after this section.

The mapping in one sentence: `loadContextResources()` corresponds to `DefaultResourceLoader.reload()`, `buildContextSystemPrompt()` to `buildSystemPrompt()` in `system-prompt.ts`, and `createContextResourceTurnState()` to `AgentHarness.createTurnState()` — chained together, that's Pi's shortest path from project resources to the current request. Two behavioral differences to know: when a skill lacks a description, mini throws outright while Pi just logs a warning diagnostic, skips that skill, and keeps loading; and the coding-agent-level `Skill` type has no content field — skill bodies are read on demand by the model — whereas mini's `ContextSkill` carries content but strips it before handing off to the harness.

## Next up

Right now, resource paths are all hard-coded by the caller, and the tool table is fixed at startup. The next section opens that up: extensions can register tools and commands, provide resource paths dynamically, and rewrite the prompt before the agent starts — plus why Pi deliberately keeps workflows like plan mode, sub-agents, and todos at that layer.

[s09 Extension Runtime](../s09_extension_runtime/README.md): the kernel only provides registration points; workflows plug in.
