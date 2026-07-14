# s12 against the Pi 0.79.1 source

s12 reconstructs the package resolver and then connects its enabled outputs to the real course runtime.

```text
configured package source
  -> installed package root
  -> manifest / conventions / filters
  -> enabled resource paths
  -> Resource and Extension loading
```

## Corresponding files

- [`packages/coding-agent/docs/packages.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/packages.md)
- [`packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/security.md)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/extensions/loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/loader.ts)
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/prompt-templates.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/agent-session.ts)

## The mapping

| s12 | Pi 0.79.1 |
| --- | --- |
| `PiManifest` and `createPackageManifest()` | the `pi` field in a package's `package.json` |
| `PackageEntry` | string and object-filter package sources |
| `resolvePiPackages()` | the package-source and resource path portion of `DefaultPackageManager.resolve()` |
| `discoverExtensionEntries()` | `collectAutoExtensionEntries()` and `resolveExtensionEntries()` |
| `applyPatterns()` | include, exclude, force-include, and force-exclude filtering |
| `projectTrusted` | the Package Manager's `SettingsManager.isProjectTrusted()` gate |
| `ResolvedResource.metadata` and `enabled` | Pi's resolved path metadata and enabled state |
| explicit `extensionSources` | already-loaded Extension modules after Pi's Extension loader |
| `promptTemplates` and `invokePromptTemplate()` | loaded Prompt Templates and explicit `expandPromptTemplate()` invocation |
| `selection.themePaths` | enabled Theme paths consumed by Pi's Resource Loader and UI |

## Package selection precedence

Pi resolves npm, Git, and local sources to installed roots. A local file is one Extension; a local directory follows package rules. The lesson models those roots in `MiniFiles` and does not perform installation or updates.

Both implementations preserve these central rules:

1. Project packages are included only after Project Trust.
2. Equivalent npm or Git identities deduplicate with project scope winning.
3. A string package with a `pi` manifest uses that manifest as its selection contract; omitted resource keys do not fall back.
4. Without a manifest, conventional resource directories are discovered.
5. Object-form filters choose and enable candidates according to manifest and fallback rules.

The lesson keeps local identities scoped, while Pi derives identity from resolved paths. This is an implementation difference, not a new resource kind.

## Resource discovery and filtering

Pi discovers Extension entrypoints rather than recursively treating every source file as an Extension. Top-level `.ts`/`.js` files, child `index.ts`/`index.js` files, and explicit manifest entries can load; nested helpers do not become independent Extensions.

For all resource types, filters operate on a candidate set. Include and exclude globs run before exact `+` and `-` overrides. Skill filters also match the parent directory identity of `SKILL.md`. s12 uses Node's `path.posix.matchesGlob()` rather than Pi's matching library but preserves the tested candidate behavior.

A `+` override cannot introduce a path that was never a candidate. That is a resolver rule, not containment. Pi resolves manifest entries directly, including `..` segments, without enforcing that the result remains below `packageRoot`; the lesson's normalized joins likewise do not promise package-root isolation.

## From enabled paths to a real Turn

Pi's `ResourceLoader` takes enabled package paths and then loads Extension modules, Skills, Prompt Templates, and Themes. s12 makes the host boundary visible:

- every enabled Extension path must match a supplied Factory in `extensionSources`;
- enabled Skill paths enter the real s08 Context Resource flow;
- enabled Prompt paths are parsed into `promptTemplates`;
- `invokePromptTemplate()` expands one selected template and submits it as a User Prompt;
- enabled Theme paths are returned but not rendered.

A normal Turn never receives every Prompt Template body in its System Prompt. This matches Pi: `AgentSession.prompt()` expands a named slash Prompt through `expandPromptTemplate()` only when it is explicitly invoked.

The explicit Factory map replaces Pi's dynamic Extension module loader for the lesson. Missing factories fail construction instead of silently importing source code.

## Course boundary

The real Package Manager also owns installation, update, settings persistence, dependency handling, diagnostics, and resource precedence across more sources. The lesson starts from an already-populated file map and implements the resolution rules needed to explain which paths take effect.

Likewise, real Pi parses and applies Themes, while s12 only reports `themePaths`. It uses the real Model, Tool loop, Extension runner, and AgentMessage Session after selection; the Package layer does not replace the Agent Core.

Package resolution provides no path or execution isolation. Project Trust decides whether project packages may load, but it is not a sandbox. Package Extensions execute with process permissions. Strong isolation belongs in an external container, VM, micro-VM, remote sandbox, or operating-system policy.

## Suggested reading order

1. Read Package Sources, Creating a Pi Package, Package Structure, and Package Filtering in `docs/packages.md`.
2. Follow `resolvePackageSources()` and `dedupePackages()` in `package-manager.ts`.
3. Read `collectPackageResources()`, `collectDefaultResources()`, and `collectManifestFiles()`.
4. Trace Extension entry discovery and `applyPatterns()`.
5. Follow enabled paths through `ResourceLoader.reload()` and `extensions/loader.ts`.
6. Finish with `loadPromptTemplates()`, `expandPromptTemplate()`, and the explicit expansion branch in `AgentSession.prompt()`.
