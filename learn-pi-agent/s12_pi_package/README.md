# s12 · Pi Package

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s11](../s11_trust_execution_env/README.md) · [Contents](../README.md) · [s13 →](../s13_integrated_harness/README.md)

> In one sentence: a package is just a distribution unit — the resolver flattens it back into the same four resource kinds (extensions, skills, prompts, themes), and the runtime gains nothing new.
>
> Where this sits in Pi: the package-manager layer of `@earendil-works/pi-coding-agent`.

→ With no installer filter, the `pi` manifest is the authoritative boundary: unlisted files aren't exported, and omitted resource keys don't fall back to the convention directories
→ An installer's filter can only shrink a package — not even `+` can smuggle in a file the author never listed
→ Not every `.ts` under `extensions/` counts as an extension — only top-level files and explicit entry points do; helpers pulled in via import don't
→ Project packages pass the s11 trust gate first; once through, they face off against a same-named global package — and the project side wins

---

## The problem

By s11, a complete workflow is scattered across four directories:

```text
extensions/review.ts
skills/review/SKILL.md
prompts/review.md
themes/review.json
```

For your own use, dropping them into `~/.pi/agent/` or the project's `.pi/` is enough. The moment you want to hand this to a team or the community, a new question shows up: given a package, how does Pi know which files are extensions, which are skills, and which are just implementation details?

At its core this is a question of authority. The package author, the directory conventions, and the person installing all want a say. Draw the boundary wrong and you get accidents — a helper the author never meant to export gets loaded into someone else's session; an installer writes `[]` thinking it means "not configured" and switches off an entire resource kind.

The package resolver written in s12 is that boundary mechanism. It introduces no new runtime capability; the output is still the same four resource kinds from the earlier units.

## The idea

A Pi package is just an ordinary npm-style directory: `package.json` gains a `pi` field that declares the four resource kinds. The resolver takes the package list from settings, resolves each source to a local directory, then computes the final file set through three layers of authority:

| Who | Where they speak | Extent of their power |
| --- | --- | --- |
| Package author | the `pi` field in `package.json` | once written, it's the authoritative boundary — unlisted files aren't exported |
| Directory conventions | `extensions/` `skills/` `prompts/` `themes/` | fallback only when the manifest is absent |
| Installer | object-form filters in settings | can only narrow within the set the author provided |

Two rules from earlier units stack on top: project packages must pass the s11 trust gate first, and when the same package is configured at both global and project scope, the project side takes effect.

This unit does no installing. npm install, git clone, and version pinning are all untouched — files are represented entirely by in-memory fixtures, and the resolver answers exactly one question: which files take effect.

## Run it first

```sh
npm run session:s12
```

Output looks like this:

```text
Extensions: 1
Skills: 1
Prompts: 1
Themes: 1
```

The demo has a single in-memory package, `/packages/review`: the manifest lists one entry per resource kind, and the package holds one file for each. The four numbers are the effective resource counts computed by `resolvePiPackages()`. The numbers themselves are unremarkable — everything in this unit is about the situations where they stop being 1.

## How the code works

Six steps.

**Step 1**: a package starts with the `pi` field in `package.json`. The demo uses `createPackageManifest()` to save a few lines of JSON:

```ts
createPackageManifest("review-pack", {
  extensions: ["extensions"],
  skills: ["skills"],
  prompts: ["prompts/review.md"],
  themes: ["themes"],
});
```

Real Pi has the same shape:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root, and entries can be files, directories, or globs.

**Step 2**: turn a source into a package root. A package entry in settings can be a local path, an `npm:` package name, or a `git:` repository: `npm:` maps to the install directory under `node_modules`, `git:` maps to a clone directory laid out by host/path, and a local absolute path is used as-is. Different spellings of the same package land on the same root — `git:github.com/team/review` and `https://github.com/team/review` resolve identically.

How the strings themselves get pulled apart is install-flow detail:

```ts
import { parseGitSource, parseNpmName } from "./source-parsing.ts";
```

Stripping the package name out of `npm:@scope/name@1.2.0` and normalizing git URLs into host/path both live in [source-parsing.ts](source-parsing.ts) in this directory — feel free to skip it on a first read. There's also one shortcut: when a source points straight at a `.ts` file, that file is a single-file extension and skips the manifest flow entirely.

**Step 3**: with no filter, the manifest is the authoritative boundary. The resolver first picks a collection mode for each resource kind:

```ts
const patterns = filter?.[resourceType];
const mode = filter
  ? patterns === undefined
    ? "filtered-default"
    : "filtered-candidates"
  : "manifest-authoritative";
const allFiles = collectPackageResourceFiles(files, packageRoot, resourceType, mode);
```

When the settings entry is just a string (string form) there is no filter, and all four kinds go through `manifest-authoritative`:

```ts
if (mode === "manifest-authoritative" && manifest) {
  return collectFilesFromEntries(files, packageRoot, manifestEntries ?? [], resourceType);
}
```

The key is `?? []`: as long as a `pi` object exists in `package.json`, it governs all four resource kinds at once. The manifest's `prompts` lists only `prompts/review.md`, so the neighboring `prompts/draft.md` isn't exported; the `skills` key isn't written, so `?? []` turns it into an empty list instead of falling back to scanning the `skills/` directory; an explicit `skills: []` likewise exports nothing.

Only when the entire `pi` field is absent do you land in the convention directories at the end of the function:

```ts
const conventionDir = joinPath(packageRoot, resourceType);
return listResourceFiles(files, conventionDir, resourceType);
```

So a tiny package can ship just the four convention directories and never write `pi` at all; but the moment you write a manifest, you have to list every kind you want exported. Even the official docs are vague about "omitted keys don't fall back to convention directories" — this unit sides with the source code.

**Step 4**: extension directory discovery adds an entry-point check. For skills, prompts, and themes, scanning a directory just means collecting files. Extensions can't work that way, because a single extension may consist of multiple files.

The rules inside the convention directory: top-level `.ts` / `.js` files are standalone entry points; a subdirectory either has an `index.ts` / `index.js`, or declares its entries via `pi.extensions` in its own `package.json`; helpers imported by an entry point are not loaded as standalone extensions.

Manifest globs obey this layer too. `extensions/*` matches both files and subdirectories: files are collected directly, and directories go through entry discovery again. So what you get is `standalone.ts` and `subagent/index.ts` — never `subagent/helper.ts`.

**Step 5**: the filter is the installer's choice, and it only narrows. Object form adds another layer of filtering for a specific package in settings:

```ts
{
  source: "/packages/review",
  extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
  prompts: [],
  themes: ["+themes/review.json"],
}
```

Six spellings, one job each:

- omit the key: this kind goes through the filtered default — use the manifest's array for that kind if it has one, and only fall back to the convention directory when the manifest doesn't list it
- `[]`: explicitly turn everything off
- plain pattern: only matches are on
- `!pattern`: exclude matches
- `+path`: force-enable one exact path
- `-path`: force-disable one exact path

Two baselines first.

First: "omitting a key" in object form is not the same as "no filter" in string form. Same package, manifest missing `skills`: under string form, skills export as empty; under object form — even with zero keys written in the filter — skills fall back to the convention directory. The moment you write object form, the resolution path changes.

Second: a filter cannot carve out anything the author didn't provide. Explicit patterns draw their candidate set from a non-empty manifest array; only when the manifest is missing or empty for that kind do candidates come from the convention directory. So a filter can shrink a non-empty manifest ever smaller, but can't squeeze in a file the author never listed — `+path` doesn't work either, because the candidate set simply doesn't contain it.

Matching uses minimatch semantics, checking three candidate spellings per resource: the package-relative path, the basename, and the absolute path; `SKILL.md` additionally checks the same three spellings of its parent directory. That's why `*.ts` can pick extensions by filename and `review` can pick a skill by directory name.

Two spots where intuition tends to fail: the `**` in `extensions/**/*.ts` matches zero or more directory levels, so the top-level `top.ts` matches too; going the other way, a glob-free `extensions` is just one exact pattern — it doesn't mean "everything under the directory". If you want directory contents, write the glob explicitly. `+` / `-` always compare exact paths, and a skill can use its directory path as its identity.

Choosing a spelling compresses to one sentence: when unsure, use plain patterns; reach for the special syntax only when you need exclusion or an exact named path.

| Scenario | What to use | Example |
| --- | --- | --- |
| Ship all skills | plain pattern | `skills/**` |
| Keep a subset, drop tests | `!pattern` | `skills/**`, `!**/*.test.*` |
| Force-include an exact path no pattern would match | `+path` | `skills/**`, `+skills/internal/legacy.md` |
| None of this kind at all | `[]` | `prompts: []` |
| Keep this kind at its default | omit the key | don't write `themes` |

One habit worth building: to say "don't filter this kind", omit the key — don't use `[]` as a placeholder. The empty array is an explicit full shutdown, and unless you genuinely want to ship an empty skeleton, it's not what you mean.

Resources switched off by a filter don't vanish; they stay in the result carrying `enabled: false` — real Pi's `ResolvedResource` has the same field. What tests and any UI above see is "this prompt was explicitly disabled", not "it doesn't exist".

**Step 6**: the trust gate comes first, and scope decides who wins. Project packages pass the s11 gate before they ever reach the resolver:

```ts
const packageEntries = dedupePackageEntries([
  ...(options.projectTrusted ? options.projectPackages.map((pkg) => ({ pkg, scope: "project" as const })) : []),
  ...options.userPackages.map((pkg) => ({ pkg, scope: "user" as const })),
]);
```

When `projectTrusted` is false, project packages never enter resolution at all, while the user's global packages load as usual. It's the same sentence as s11: trust governs the loading of project inputs, not an execution sandbox.

When the same package is configured on both sides, dedupe goes by source identity — npm by package name, git by host/path, local paths kept once per scope:

```ts
if (!existing || (entry.scope === "project" && existing.scope === "user")) {
  seen.set(identity, entry);
}
```

Project entries are listed first, so when identities collide the global entry never gets in: a project can pin its own workflow without a same-named package from the user's global settings taking it over.

## Try it yourself

Open `demo()` at the bottom of `code.ts` — the fixture lives there. After each change, rerun `npm run session:s12` and watch the four numbers.

1. Add a neighboring file to the fixture:

```ts
"/packages/review/prompts/draft.md": "Draft release notes.",
```

Prompts stays at 1. The manifest lists only `prompts/review.md`; a file sitting next to it doesn't get exported along for the ride.

2. Keep draft.md, and replace the `createPackageManifest(...)` block with `JSON.stringify({ name: "review-pack" })`. Prompts becomes 2 — only without a `pi` field do the four kinds fall back to the convention directories. Now restore the manifest but delete the `prompts: ["prompts/review.md"]` line: Prompts becomes 0, not 2. Omitting a key and having no manifest are two different paths.

3. Restore the manifest, keep draft.md, then swap `userPackages: ["/packages/review"]` for object form:

```ts
userPackages: [{ source: "/packages/review", prompts: [] }],
```

Prompts drops to 0 and the other three numbers don't move — `[]` is an explicit full shutdown. Now try `prompts: ["prompts/draft.md"]`, hoping to fish out the draft.md from step 1: Prompts is still 0, because the candidate set comes from the files the manifest listed, and draft.md isn't among them. Switch to `["+prompts/draft.md"]` and Prompts comes back to 1 — but the file that takes effect is review.md. With no plain pattern, every candidate survives, and the file `+` tried to force open still isn't a candidate. This is "a filter can only shrink" in a form you can touch.

When you're done, restore `demo()` and run `npm run test:s12` to confirm the resolver's behavioral contract still holds.

## Wiring into the main line

The resolver's output brings no new runtime system: extensions go back to s09 for loading, skills, prompts, and themes go back to s08, and the runtime shells are still the s10 lineup. What s12 welds on is the "distribution" link:

| Component | s11 | s12 |
| --- | --- | --- |
| Where resources come from | loose files in the project `.pi/` and the user's global directory | file sets carved out of a package root by the manifest or convention directories |
| Inputs behind the trust gate | project settings, extensions, prompts | one more kind: project packages don't reach the resolver without passing the gate |
| What the installer can configure | trust decisions (approve / store / default) | the packages list in settings + object-form filters |
| Output | a single `projectTrusted` boolean | four resource lists carrying `enabled` and `scope` |

## Against the Pi source

Finish this unit, then read [pi-source.md](pi-source.md).

The mapping in one sentence: s12's `resolvePiPackages()` corresponds to the minimal path through `DefaultPackageManager.resolve()` in Pi's `package-manager.ts`. Read `docs/packages.md` first for the package author's mental model, then look at how `collectPackageResources()` and `applyPackageFilter()` merge the manifest, convention directories, and filters. Real Pi has a whole installation machinery beyond this line — npm install, git clone, pinned versions, offline mode. When you hit the install flow you can stop; it doesn't affect the resolver main line.

## Next up

What s12 completes is the package resolver: from in-memory files and configuration, it can compute which extensions, skills, prompts, and themes take effect — but those results aren't wired into an agent turn yet. s13 writes no new mechanisms; it does adaptation and orchestration only — reusing the public interfaces of the earlier units to compose trust, package, resource, extension, tool loop, session, and runtime mode into one deterministic offline chain.

Set expectations right too: s13's packages and extensions are still in-memory fixtures. It won't install packages or dynamically import TypeScript, and it includes no context compaction, hot reload, or sandbox.

To keep going into real Pi's engineering details, these are good entry points to drill into (line numbers are marked in [pi-source.md](pi-source.md)):

```text
offline mode and pinned npm versions   the source taxonomy in docs/packages.md:50-112, the install flow in package-manager.ts
installing git ref dependencies        git clone / git fetch in package-manager.ts, how pinned refs land on disk
name collision diagnostics             resource precedence ordering and collision diagnostics
```

[s13 Integrated Harness](../s13_integrated_harness/README.md): the parts raised over twelve units, joined into one deterministic request chain that actually runs. After that, s14 keeps the same chain and replaces the fixture provider with an optional OpenAI-compatible live provider.
