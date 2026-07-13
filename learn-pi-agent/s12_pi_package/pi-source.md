# s12 Against the Pi Source

s12 corresponds to Pi's package resolver.

This unit is checked against the repository's pinned `@earendil-works/pi-coding-agent` 0.79.1, git commit `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`.

```text
package source
  -> installed package root
  -> pi manifest or conventional directories
  -> extensions / skills / prompts / themes
  -> ResourceLoader
```

## The files

- [`packages/coding-agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/README.md)
- [`packages/coding-agent/docs/packages.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/packages.md)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/settings-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/settings-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)

Specific anchors:

```text
README.md:402-449                 Pi Packages overview, install commands, and a manifest example
README.md:491-501                 why so many workflows are handed to extensions / skills / packages
docs/packages.md:18-48            install / remove / update / temporary -e
docs/packages.md:50-112           the three source kinds: npm, git, local path
docs/packages.md:114-131          the pi manifest in package.json
docs/packages.md:154-163          conventional directories
docs/packages.md:165-186          dependencies / peerDependencies / bundledDependencies
docs/packages.md:188-210          package filtering
package-manager.ts:147-153        PiManifest
package-manager.ts:179-188        PackageFilter and RESOURCE_TYPES
package-manager.ts:534-630        extension top-level files, subdirectory index / manifest entry discovery
package-manager.ts:632-761        the filter's minimatch candidates, skill directory identity, +/- ordering
package-manager.ts:885-921        resolve() gathering project/user packages, local entries, and auto resources
package-manager.ts:1209-1266      resolvePackageSources()
package-manager.ts:1270-1295      local path source: a file becomes a single extension, a directory resolves by package rules
package-manager.ts:1645-1667      dedupePackages(), project packages override global packages
package-manager.ts:1678-1682      project package storage requires projectTrusted
package-manager.ts:2030-2073      collectPackageResources()
package-manager.ts:2076-2096      collectDefaultResources()
package-manager.ts:2098-2122      applyPackageFilter()
package-manager.ts:2129-2148      file sets from the manifest and conventional directories
package-manager.ts:2151-2164      readPiManifest()
package-manager.ts:2186-2200      manifest globs expand both files and directories
package-manager.ts:2392-2408      after a glob hits a directory, entry discovery continues per resource type
test/package-manager.test.ts:1950-2051 regression test that a multi-file extension doesn't treat helpers as standalone entries
                                  (lives under packages/coding-agent/test/, not src/core/)
package-manager.ts:2226-2390      addAutoDiscoveredResources(), project resources gated by trust
package-manager.ts:2450-2470      toResolvedPaths()
settings-manager.ts:911-921       packages / setPackages / setProjectPackages
resource-loader.ts:333-343        reload resolves project trust first, then calls packageManager.resolve()
```

## The mapping

| s12 | Pi |
| --- | --- |
| `createPackageManifest()` | the `pi` manifest in `package.json` |
| `PackageEntry` | `PackageSource` in string / object-filter form |
| `resolvePiPackages()` | a minimal `DefaultPackageManager.resolve()` |
| `collectPackageResourceFiles()` | `collectPackageResources()` / `collectDefaultResources()` / `collectManifestFiles()` |
| `collectAutoExtensionEntries()` | `collectAutoExtensionEntries()` / `resolveExtensionEntries()` |
| `matchesPattern()` / `matchesExactPath()` | `matchesAnyPattern()` / `matchesAnyExactPattern()` |
| `applyPatterns()` | `applyPatterns()`, in order: include / exclude / force-include / force-exclude |
| `projectTrusted` | `SettingsManager.isProjectTrusted()` |
| `metadata.scope` | `PathMetadata.scope` |
| `enabled` | `ResolvedResource.enabled` |

## What this unit simplifies

Real Pi's package manager does a lot of engineering work:

```text
npm install / git clone / git fetch
pinned npm versions and git refs
offline mode
dependency install
settings.json persistence
progress events
ignore files and symlink handling
path canonicalization and cloud sync ignore
package update checks
resource precedence ordering and name collision diagnostics
```

s12 implements none of that. It keeps only the resolver main line:

```text
package root
  -> string form: manifest authoritative, otherwise convention
  -> object form: filtered default or filtered candidates
  -> extension entry discovery
  -> resource list
```

A few 0.79.1 details are preserved on purpose: in string form, when a `pi` manifest exists, omitted resource keys don't fall back; only an object-form filter chooses between the manifest and the convention directories, by the rules of `collectDefaultResources()` / `collectManifestFiles()`. Extension directories likewise only discover top-level `.ts` / `.js` files and explicit sub-entries — helpers are never loaded recursively — and when a manifest glob hits a directory, entry discovery continues inside it.

Filter matching uses Node's built-in `node:path.posix.matchesGlob()` (available since v22.5) to express the same globstar-style path semantics as upstream minimatch, and like Pi it separately checks the relative path, basename, absolute path, and the skill's parent-directory candidates. That keeps the teaching project free of runtime dependencies.

There's also one local-path identity difference: mini keys local paths as `local:${scope}:${source}` (the same path can be kept once per scope), while real Pi's identity is the resolved absolute path (`docs/packages.md:227`, `package-manager.ts:1634-1638`), so the same absolute path dedupes across scopes with project winning. The observable results happen to be equivalent (first-come-first-kept + project listed first), but the mechanisms differ.

This is the part a newcomer needs to grasp first. The real install and update flows can wait — they don't belong in a first pass through the course.

## How this connects to earlier units

```text
s08 Context Resources    a package's end products are still skills, prompts, themes
s09 Extension Runtime    a package can carry extensions
s11 Trust Env            project packages enter resource resolution only after trust
s12 Pi Package           bundles the outer-layer capabilities into an installable distribution unit
```

The point of a Pi package is distributing a workflow without forking Pi. It's also where the whole course converges: Pi core stays small, and outer-layer capability grows outward through resources, extensions, and packages.

## Suggested reading order

Start with Creating a Pi Package and Package Structure in `docs/packages.md`. That shows what a package author has to write.

Then look at `collectPackageResources()` and `applyPackageFilter()` in `package-manager.ts`. Those two passages explain how the manifest, convention directories, and settings filters merge.

Finish with `resolve()` and `dedupePackages()`. That's where you see the project/user scope ordering, and why a project package can override a global one.
