# s12 · Pi Package

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the resolver that turns configured package sources into enabled Extensions, Skills, Prompt Templates, and Themes before Resource loading.

```text
package entries + installed file map + projectTrusted
  -> resolvePiPackages()
  -> enabled paths
       +-> Extension path -> explicit factory -> Extension runner
       +-> Skill path -------------------------> Context Resources
       +-> Prompt path ------------------------> explicit invocation catalog
       +-> Theme path -------------------------> selection only in s12
  -> the same MiniCoreRuntime
```

## The problem

By s11, the Harness can load Extensions, Skills, and Prompt Templates from known paths. Sharing a workflow still requires a distribution contract: given a package source, which files count as resources, which ones are disabled, and which scope wins when the same package appears twice?

A package is not a new Agent mechanism. It is a way to select and group resource paths before the existing Resource Loader and Extension Runtime see them. The difficult part is preserving three different authorities without confusing them:

| Authority | What it decides |
| --- | --- |
| package author | the resources exported by a `pi` manifest |
| directory convention | fallback discovery when manifest rules permit it |
| installer configuration | which candidate resources remain enabled |

This is selection authority, not a filesystem or execution security boundary. Manifest entries may resolve outside the package directory, and selected Extensions still run with the host process's permissions.

## The idea

s12 separates package resolution from runtime activation.

`resolvePiPackages()` accepts a normalized file map, user and project package entries, a Project Trust decision, and the roots where package sources are already present. It returns four lists of `ResolvedResource` objects. Each object retains its path, scope metadata, source, and `enabled` flag.

`createPackageRuntime()` then activates only enabled resources:

| Resource | What s12 does with it |
| --- | --- |
| Extension | requires a matching, explicit `MiniExtensionSource` factory and loads it into the Extension runner |
| Skill | adds the path to the real Context Resource Turn |
| Prompt | loads catalog metadata and expands the template only when `invokePromptTemplate()` is called |
| Theme | reports the enabled path in `selection.themePaths`; no TUI applies it in this lesson |

Project packages enter resolution only when `projectTrusted` is true. For duplicate npm or Git identities, the project entry wins over the user entry.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s12 -- "Use read_file to inspect package.json and summarize this lesson's dependencies."
```

This lesson does not install Packages. It explains how Package resources that already exist are resolved and used to configure the real Runtime. The CLI supplies empty package lists and an empty file map while exercising the same Model, Session Tree, Extension Turn, and Tool loop from the earlier lessons.

To observe package behavior, call `resolvePiPackages()` with the host's existing file map and package entries, then pass the same inputs to `createPackageRuntime()`. The returned `selection` shows which resource paths are enabled, while the Runtime and Session show how those resources affect a Turn.

## How the code works

### 1. Resolve package sources and scope

`resolvePackageSourcePath()` maps configured sources to locations where the host has already placed them:

| Source | User scope | Project scope |
| --- | --- | --- |
| `npm:name` | `~/.pi/agent/npm/node_modules/name` | `.pi/npm/node_modules/name` |
| Git source | `~/.pi/agent/git/host/path` | `.pi/git/host/path` |
| relative local path | relative to Agent directory | relative to project `.pi/` |
| absolute local file | the file itself | the file itself |

A local file is treated as one Extension. A directory continues through package rules. Missing roots are skipped because s12 neither installs nor fetches anything.

Project packages are considered first, then user packages. `dedupePackageEntries()` identifies npm and Git sources independent of scope, so the project version wins. Local identities keep their scope.

### 2. Combine manifest, conventions, and filters

The exact rule depends on package-entry form.

For a string entry, an existing `pi` manifest is authoritative for resource selection: a missing or empty key exports nothing for that type. With no manifest, the conventional `extensions/`, `skills/`, `prompts/`, and `themes/` directories are used.

For an object entry with installer filters:

- if a filter key is omitted, a present manifest key is used, including an empty array; otherwise conventions supply candidates;
- if a filter key is present, a non-empty manifest key supplies candidates; a missing or empty key falls back to conventions before filtering;
- include and `!` patterns select or remove candidates, then exact `+` and `-` overrides run in order;
- a force-include can only re-enable a known candidate. It cannot manufacture a path outside the candidate set.

The resolver preserves disabled candidates in its result. `getEnabledPaths()` is the boundary used before runtime activation.

### 3. Discover Extension entrypoints, then require factories

Extension discovery does not treat every nested `.ts` or `.js` file as an Extension. It accepts top-level files, a child directory's `index.ts` or `index.js`, or explicit entries from that child directory's manifest. Imported helper files stay helpers.

Resolution produces paths, not executable modules. `createPackageRuntime()` builds a map from every supplied `extensionSources[].path` to its factory. If an enabled package Extension has no matching factory, construction fails:

```ts
const source = extensionByPath.get(normalizePath(path));
if (!source) {
  throw new Error("Missing extension factory for resolved package path: " + path);
}
```

That explicit map is the lesson's host contract. It makes execution eligibility visible, but it is not a sandbox. s12 does not dynamically import arbitrary TypeScript.

### 4. Put enabled resources into a real Turn

After selection, `createPackageRuntime()` composes the same runtime built in s10:

```ts
const prepared = await createPackageRuntime({
  files,
  userPackages: ["/packages/review"],
  projectPackages: [],
  projectTrusted: true,
  extensionSources: [{ path: extensionPath, factory: reviewExtension }],
  runtimeOptions,
});

await runPrintMode(prepared.runtime, "Review this change");
```

Enabled Extensions register real Tools and Hooks. Enabled Skills enter the System Prompt through s08. Enabled Prompt files become entries in `prepared.promptTemplates`; an ordinary Turn does not inject their bodies into the System Prompt. `prepared.invokePromptTemplate(name, args)` uses s08's `formatPromptTemplateInvocation()` and submits the expanded text as that Turn's User Prompt. During a normal Turn, the Model context contains the Skill and Tool, the package Tool can run, and the real AgentMessage Session records the resulting Tool Call and Tool Result.

Themes remain presentation resources. Their enabled paths are observable in `selection.themePaths`, but this lesson has no theme renderer.

## Try it yourself

1. Give a string package a `pi` manifest that omits `prompts`. Add a conventional Prompt file and confirm it remains unexported.
2. Change the same source to object form with an explicit Prompt filter. Observe when conventions become the candidate set and when the filter disables a path.
3. Put `helper.ts` next to a child Extension's `index.ts`. `discoverExtensionEntries()` should select only the entrypoint.
4. Resolve an enabled Extension without adding it to `extensionSources`. Construction should fail rather than importing it.
5. Send an ordinary Prompt through `prepared.runtime`, then inspect the Model's Tool list, System Prompt, and AgentMessage Session. Extension and Skill resources should affect that Turn, but the Prompt body must remain absent until `invokePromptTemplate()` submits it as User input. Theme should remain selection data.
6. Set `projectTrusted` to false and verify that user packages remain while project packages disappear.

## Wiring into the main line

| Boundary | s11 | s12 |
| --- | --- | --- |
| Trust | decides whether project inputs participate | gates the entire project package list |
| Resource paths | direct project paths | paths selected from package sources |
| Extensions | trusted direct Extension paths | enabled package paths plus explicit factories |
| Skills and Prompts | trusted direct paths | enabled paths loaded; Prompt text enters only on explicit invocation |
| Themes | not used | resolved and reported, not rendered |
| Core and Session | one real cumulative runtime | unchanged |

## Against the Pi source

Pi 0.79.1 follows the same resolver model: npm, Git, and local sources lead to package roots; `package.json#pi` and conventional directories identify resource candidates; filters set enabled state; Project Trust gates project packages; project scope wins duplicate identities; and `ResourceLoader` consumes enabled paths.

Real Pi also installs and updates packages, dynamically loads Extension modules, parses every supported resource type, reports diagnostics, and applies Themes in its UI. s12 expects an already-populated file map, uses an explicit factory map, and leaves Themes as selection data.

Neither implementation treats the package root as a containment boundary. A manifest entry is a resource-selection instruction, not a sandbox rule. Review package content before loading it, and use an external container, VM, micro-VM, remote sandbox, or OS policy when strong isolation is required.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## Next up

[s13 · Integrated Harness](../s13_integrated_harness/) composes Project Trust, direct and packaged Resources, Extensions, a real Model, an AgentMessage Session, and every runtime shell into one host-facing API.
