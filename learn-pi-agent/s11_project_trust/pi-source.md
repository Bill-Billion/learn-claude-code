# s11 against the Pi 0.79.1 source

s11 reconstructs Project Trust as a loading gate that runs before the shared Agent Session runtime is configured.

```text
detect protected project inputs
  -> resolve projectTrusted
  -> reload project resources for that decision
```

## Corresponding files

- [`packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/security.md)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/trust-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/trust-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/settings-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/settings-manager.ts)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/extensions/runner.ts)

## The mapping

| s11 | Pi 0.79.1 |
| --- | --- |
| `hasProjectTrustInputs()` | `hasProjectTrustInputs()` in `trust-manager.ts` |
| `MiniTrustStore` | the nearest-path behavior of `ProjectTrustStore` |
| `resolveProjectTrusted()` | `resolveProjectTrusted()` in `project-trust.ts` |
| `extensionDecision` | the result of the `project_trust` Extension Event |
| `loadProjectInputs()` | the trust-sensitive project resource selection performed by Settings, Package, and Resource loaders |
| trust-independent `contextFiles` | per-directory candidate discovery in `resource-loader.ts` |
| `createProjectTrustRuntime()` | resolving trust before the final resource reload and Agent Session setup |

No Tool execution-backend concept is mapped in this unit. Project Trust is about loading project input, not selecting how Tools run.

## Trust inputs and decision order

Pi treats two filesystem conditions as trust inputs: a `.pi/` directory in the current working directory, or `.agents/skills/` in the current directory or any ancestor. `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` are not trust inputs.

Pi's decision order is the same one made visible by s11:

```text
--approve / --no-approve override
  -> no trust inputs: trusted
  -> first decisive project_trust Extension result
  -> closest saved cwd-or-parent decision
  -> defaultProjectTrust: always / never / ask
  -> ask with no UI: untrusted
  -> interactive selection
```

`ProjectTrustStore` canonicalizes paths, reads `~/.pi/agent/trust.json`, and applies the nearest saved entry. The lesson's `MiniTrustStore` keeps the upward lookup but uses memory instead of locking and updating a persistent file.

Before trust is resolved, Pi can load user/global Extensions and temporary CLI Extensions. Those Extensions may handle `project_trust`; the first yes/no result owns the decision, and `remember: true` stores it. The lesson injects that result as `extensionDecision` rather than loading an Extension during bootstrap.

## The loading gate

Pi's `ResourceLoader.reload()` first forces project settings to untrusted for a bootstrap pass. It obtains any pre-trust Extension decision, sets `projectTrusted` on `SettingsManager`, reloads settings, resolves packages and project resources, then loads the final Extension set.

The boundary is asymmetric:

- In each directory, the first existing Context candidate in the order `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` loads regardless of Project Trust unless Context loading is explicitly disabled.
- Untrusted projects skip protected project settings, resources, packages, and Extensions.
- Trusted projects may load `.pi/settings.json`, `.pi` resources such as Extensions, Skills, Prompt Templates, Themes, and System Prompt files, project packages, and ancestor `.agents/skills`.

The lesson models the same gate with a deliberately narrower resource list: current `.pi/settings.json`, `.pi/extensions`, `.pi/prompts`, `.pi/packages`, and ancestor `.agents/skills`. It does not claim to implement Pi's complete `.pi` resource discovery.

## Not a sandbox

Pi's security documentation is explicit: Project Trust is not a sandbox and does not restrict what the Model may ask Tools to do after startup. Built-in Tools and Extensions run with the permissions of the Pi process.

The `read_file` path boundary inherited by the course is local policy in that teaching Tool. It is not enforced by Pi's Project Trust, does not constrain arbitrary Extensions or host processes, and must not be presented as strong isolation.

For untrusted or unattended work, Pi recommends an external container, VM, micro-VM, remote sandbox, or policy-controlled sandbox. Mount and credential choices still determine what that environment can affect.

## Course scope

The lesson keeps the parts needed to test the boundary:

- deterministic file discovery through `MiniFiles` plus a real-filesystem adapter for the CLI;
- override, Extension, nearest saved, default, and interactive decision branches;
- context that survives a declined decision;
- trusted Skill and Prompt paths wired into the same real `MiniCoreRuntime`.

It leaves out the interactive selection UI, persistent `trust.json` locking, full Settings reload, Package installation and resolution, Project Extension execution, Themes, System Prompt files, and Pi's broader Resource graph. Settings, Extension, and package paths are enumerated but not activated.

## Suggested reading order

1. Read the Project Trust and No Built-in Sandbox sections of `docs/security.md`.
2. Follow `hasProjectTrustInputs()` and `ProjectTrustStore.get()` in `trust-manager.ts`.
3. Read `resolveProjectTrusted()` from override through the no-UI fallback.
4. Follow the bootstrap and trusted reload in `ResourceLoader.reload()`.
5. Trace `projectTrusted` through `SettingsManager` and `PackageManager`.
6. Compare those boundaries with `MiniTrustStore`, `loadProjectInputs()`, and `createProjectTrustRuntime()`.
