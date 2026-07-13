# Pi Source Map for s11

s11 maps to Pi's project trust and execution-environment boundary.

```text
project trust
  -> decide whether project-local inputs load
  -> does not sandbox tools
  -> real isolation belongs to env / container / VM / custom operations
```

## Mapped files

- [`packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/security.md)
- [`packages/coding-agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/README.md)
- [`packages/coding-agent/src/core/project-trust.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/project-trust.ts)
- [`packages/coding-agent/src/core/trust-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/trust-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)
- [`packages/coding-agent/src/core/tools/write.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/write.ts)
- [`packages/coding-agent/src/core/tools/bash.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/bash.ts)
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/extensions.md)

Specific anchors:

```text
docs/security.md:3-7              Pi runs with local user privileges; project trust is not a sandbox
docs/security.md:9-25             trust inputs, loading scope, and non-interactive behavior
docs/security.md:27-33            No Built-in Sandbox
docs/security.md:35-49            untrusted work belongs in a container, VM, micro-VM, or controlled sandbox
README.md:294-304                 the Project Trust user docs
README.md:497                     No permission popups
project-trust.ts:11               AppMode
project-trust.ts:45-95            resolveProjectTrusted()
trust-manager.ts:32-45            nearest-parent trust decisions
trust-manager.ts:58-87            trust options, including session only and trust parent folder
trust-manager.ts:174-190          hasProjectTrustInputs()
trust-manager.ts:193-229          ProjectTrustStore
resource-loader.ts:325-342        user/global and CLI extensions load before trust, then reload by trust state
resource-loader.ts:951-977        project SYSTEM.md / APPEND_SYSTEM.md load only when trusted
read.ts:39-62                     ReadOperations is swappable, defaults to the local filesystem
write.ts:21-39                    WriteOperations is swappable, defaults to the local filesystem
bash.ts:36-66                     BashOperations is swappable
bash.ts:66-85                     the default local shell backend
extensions.md:340-355             the project_trust event
extensions.md:1905-1944           built-in tools' operations can target SSH, containers, other remotes (Gondolin at extensions.md:2638)
```

## Mapping

| s11 | Pi |
| --- | --- |
| `hasProjectTrustInputs()` | `hasProjectTrustInputs()` in `trust-manager.ts` |
| `MiniTrustStore` | `ProjectTrustStore` |
| `resolveProjectTrusted()` | `resolveProjectTrusted()` in `project-trust.ts` |
| `extensionDecision` | the `project_trust` extension event result |
| `loadProjectInputs()` | resource loading by trust state after `ResourceLoader.reload()` |
| `createLocalExecutionEnv()` | the default local operations of read/write/bash |
| `createContainedExecutionEnv()` | custom operations and outer execution policies: containers, VMs, Gondolin |

## What s11 simplifies

Real Pi's trust and execution environment carry much more than s11:

```text
the real filesystem and canonical paths
the trust.json file lock
trust parent folder / session only UI options
error collection for the project_trust event
settings reload and package manager resolve
the full upward-lookup rules for AGENTS.md / CLAUDE.md
full rendering, truncation, queueing, and abort handling for read / write / edit / bash
concrete execution backends like Gondolin, OpenShell, Docker
the non-interactive test: the mini uses mode !== "interactive"; Pi actually checks projectTrustContext.hasUI
  (project-trust.ts:85)
```

s11 implements none of these. It keeps one key distinction:

```text
trust is an input-loading switch, not an execution-permission boundary
```

That distinction matters more than a few extra security checks. Without it, a reader can easily believe that `--no-approve` protects the filesystem, or that trusting a project makes everything safe.

## How it connects to earlier units

```text
s08 Context Resources    how resources enter turn state
s09 Extension Runtime    how extensions register capabilities
s10 Runtime Modes        non-interactive modes have no UI prompt
s11 Trust Env            decides which project-local resources and extensions may load
```

So s11 puts a fence around s08 through s10: resources and extensions don't load unconditionally; whether the user can be asked depends on the runtime mode; and tool execution privileges still come from the environment the process runs in.

## Suggested reading order

Read `docs/security.md` first. It's a better entry point than the source, because it states Pi's security model directly.

Then `project-trust.ts`. The code is short, and you can see the order: override, extension decision, saved decision, defaultProjectTrust, and the UI prompt.

Finish with the operations interfaces in `read.ts`, `write.ts`, and `bash.ts`. Pi didn't hard-wire a sandbox into the core; it allows tool execution to move to a different backend.
