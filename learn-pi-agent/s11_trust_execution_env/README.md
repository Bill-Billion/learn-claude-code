# s11 · Trust And Execution Env

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s10](../s10_runtime_modes/README.md) · [Contents](../README.md) · [s12 →](../s12_pi_package/README.md)

> In one sentence: project trust is the loading switch for project inputs, and the execution env is the pluggable backend for tool execution — two boundaries, and neither covers for the other.
>
> Where this sits in Pi: `project-trust.ts` and `trust-manager.ts` in `@earendil-works/pi-coding-agent`, plus the operations socket on the read/write/bash tools; the authoritative account of the security model is `docs/security.md`.

→ Decline trust and the agent can still read secrets, write files, and run shell — trust was never a permission system
→ AGENTS.md doesn't count as a trust input and loads even without trust: an untrusted repo's AGENTS.md is a prompt injection surface, and Pi says outright that this is an expected risk
→ This unit's contained env blocks bash with a prefix check, and `npm test; rm -rf /` walks right through — it demonstrates the operations socket, not a third security mechanism
→ Real isolation has exactly one source: an OS or virtualization/container boundary, always on the far side of the socket

---

## The problem

By s10, mini Pi can drive one runtime through different entry points. Two questions naturally come next: if you clone an unfamiliar repo containing `.pi/settings.json`, `.pi/extensions/`, and project skills, will Pi just load them? And: if I decline trust, does that mean Pi can no longer read or write files, or run shell?

The answer to the first is "it asks you first"; to the second, "it can still do all of it." The two answers come from two mechanisms that never cover for each other — and blending them into one "security switch" is exactly the misconception this unit takes apart.

## The idea

Pi splits this into two boundaries:

| Boundary | What it answers | What it doesn't touch |
| --- | --- | --- |
| project trust | whether to load the inputs that change Pi's behavior — `.pi/settings.json`, project extensions, prompts, packages | file reads and writes, shell, whether model output is safe |
| execution env | which backend read / write / bash land on | isolation strength — that depends on whether the backend is outside the process |

What trust guards against is concrete: a repo must not silently rewrite Pi's configuration or smuggle in extension code before you approve it. It governs input loading, with a one-shot yes/no.

Execution permission is a different matter. Pi is a local coding agent: read, write, bash, and extension code all run with the privileges of the user who launched Pi. Pi deliberately builds no in-process sandbox; the reasoning in `docs/security.md`: an incomplete in-process sandbox is too easily mistaken for a security boundary, while it still depends on the host's shell, filesystem, package manager, and credentials — real isolation must come from the operating system or a virtualization/container boundary.

Following that model, this unit writes three parts: a trust decider (`resolveProjectTrusted()` + `MiniTrustStore`), an input loader (`loadProjectInputs()`), and two execution envs (local and contained). The contained env is deliberately built as exactly the kind of in-process check Pi warns about — we'll puncture it ourselves at the end.

## Run it first

```sh
npm run session:s11
```

The output looks like this:

```text
Project trusted: false
Context files: /repo/AGENTS.md
Extensions loaded: 0
Local read still works: token
Contained bash: contained:/repo$ npm test
```

The demo starts in print mode with `defaultProjectTrust: "ask"` — a non-interactive mode can't ask anyone, so trust falls to false and zero project extensions load. But look at the lines that follow: AGENTS.md still made it into the context files, and the local env still read `token`, the content of secret.txt. The contained env on the last line is a separate layer of policy with no relationship to trust being false.

## How the code works

### What counts as a trust input

```ts
export function hasProjectTrustInputs(files: MiniFiles, cwd: string): boolean {
  const normalizedCwd = normalizePath(cwd);
  if (hasDirectory(files, joinPath(normalizedCwd, ".pi"))) {
    return true;
  }

  let current = normalizedCwd;
  while (true) {
    if (hasDirectory(files, joinPath(current, ".agents", "skills"))) {
      return true;
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
```

Same criterion as real Pi: a `.pi/` in the current directory, or a `.agents/skills` in the current directory or any ancestor, means the project has inputs that require trust. Note what's missing from the list: AGENTS.md. That absence is not an oversight — we'll come back to it below.

### The trust decision answers exactly one yes/no

```ts
export async function resolveProjectTrusted(options: ResolveProjectTrustOptions): Promise<boolean> {
  if (options.trustOverride !== undefined) {
    return options.trustOverride;
  }

  if (!hasProjectTrustInputs(options.files, options.cwd)) {
    return true;
  }

  if (options.extensionDecision && options.extensionDecision.trusted !== "undecided") {
    const trusted = options.extensionDecision.trusted === "yes";
    if (options.extensionDecision.remember === true) {
      options.trustStore.set(options.cwd, trusted);
    }
    return trusted;
  }

  const storedDecision = options.trustStore.get(options.cwd);
  if (storedDecision !== null) {
    return storedDecision;
  }

  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return true;
    case "never":
      return false;
    case "ask":
      break;
  }

  if (options.mode !== "interactive") {
    return false;
  }
  return options.promptDecision === true;
}
```

Read it top to bottom and you have the decision order, identical to real Pi:

```text
--approve / --no-approve decides outright (trustOverride)
no trust inputs: pass straight through
the project_trust extension's decision, which remember can save into the trust store
a stored decision for the current directory or nearest parent in the trust store
defaultProjectTrust: always / never / ask
ask and non-interactive: no one to ask, return false
ask and interactive: whatever the user chooses on the spot (promptDecision)
```

The second-to-last rule is why the demo prints `Project trusted: false`: `-p`, `--mode json`, and `--mode rpc` have no UI, and on ask they don't stop to wait for a human. s10's modes make their second appearance here — the shape of the shell decides whether a dialog can even be shown.

### What still loads after trust is declined

```ts
export function loadProjectInputs(files: MiniFiles, cwd: string, projectTrusted: boolean): LoadedProjectInputs {
  const normalizedCwd = normalizePath(cwd);
  const contextFiles = [joinPath(normalizedCwd, "AGENTS.md"), joinPath(normalizedCwd, "CLAUDE.md")].filter((path) =>
    hasFile(files, path),
  );

  if (!projectTrusted) {
    return {
      contextFiles,
      projectSettingsLoaded: false,
      extensionPaths: [],
      promptPaths: [],
    };
  }

  return {
    contextFiles,
    projectSettingsLoaded: hasFile(files, joinPath(normalizedCwd, ".pi", "settings.json")),
    extensionPaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "extensions")),
    promptPaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "prompts")),
  };
}
```

Inputs fall into two classes: AGENTS.md and CLAUDE.md are ordinary context files that don't pass through the trust gate; `.pi/settings.json`, `.pi/extensions`, and `.pi/prompts` are trust-gated inputs, skipped on decline. Real Pi's resource loading is finer-grained, but the main line is the same: before trust, only context files, user/global extensions, and CLI `-e` extensions load; anything project-local waits for trust to pass.

Now translate the mechanical fact "AGENTS.md doesn't pass through the gate" into its security meaning: you clone a strange repo, cautiously decline trust, and its AGENTS.md still enters the model context word for word — an untrusted repo's AGENTS.md is a prompt injection surface. Pi's security.md doesn't hide this: trust blocks the loading of configuration and extension code; it cannot make untrusted prompts or untrusted model output safe. Prompt injection from repo files is an expected local-agent risk, and Pi doesn't promise to reliably intercept it.

### local env: decline trust, and everything still works

```ts
export function createLocalExecutionEnv(files: MiniFiles): ExecutionEnv {
  const state = cloneFiles(files);

  return {
    async readFile(path: string): Promise<string> {
      return readFromState(state, path);
    },
    async writeFile(path: string, content: string): Promise<void> {
      state[normalizePath(path)] = content;
    },
    async runBash(command: string, cwd: string): Promise<string> {
      return `local:${normalizePath(cwd)}$ ${command}`;
    },
  };
}
```

In the demo, this part deliberately runs after trust was declined: trust is false, and `readFile("/repo/secret.txt")` still returns `token`. Project trust is not a permission system — declining only skips loading the project-local `.pi` inputs; it doesn't make the filesystem read-only, and it doesn't intercept shell. Real Pi is exactly the same: built-in tools default to the local filesystem and local shell, with the privileges of whoever launched Pi. To actually restrict anything, you swap the execution env — which is the socket the next part is about.

### contained env: first what it blocks, then what it can't

```ts
export function createContainedExecutionEnv(files: MiniFiles, options: ContainedExecutionEnvOptions): ExecutionEnv {
  const state = cloneFiles(files);
  const root = normalizePath(options.root);

  return {
    async readFile(path: string): Promise<string> {
      assertInsideRoot(path, root);
      return readFromState(state, path);
    },
    async writeFile(path: string, content: string): Promise<void> {
      assertInsideRoot(path, root);
      state[normalizePath(path)] = content;
    },
    async runBash(command: string, cwd: string): Promise<string> {
      assertInsideRoot(cwd, root);
      if (!options.allowedBashPrefixes.some((prefix) => command.startsWith(prefix))) {
        throw new Error(`command blocked by contained env: ${command}`);
      }
      return `contained:${normalizePath(cwd)}$ ${command}`;
    },
  };
}
```

The demo hands it these parameters:

```ts
const containedEnv = createContainedExecutionEnv(files, { root: "/repo", allowedBashPrefixes: ["npm "] });
```

Reads and writes are confined to `/repo`, and bash only passes commands starting with `npm `. Looks like a sandbox? Now puncture it yourself: the `startsWith` prefix check is precisely the kind of "partial in-process sandbox" security.md warns about — `npm test; rm -rf /` starts with `npm `, straight through. So don't file this contained env away as a third security mechanism next to trust and the local env. What it actually demonstrates is the operations socket on Pi's tools: the entire backend behind read, write, and bash is swappable — for SSH to a controlled machine, a Docker container, a Gondolin micro-VM. Real isolation happens on the far side of the socket, provided by an OS or virtualization boundary; the socket itself is just a mount point for policy.

## Try it yourself

1. Flip trust: in `demo()`, change `mode: "print"` to `mode: "interactive"` and add a line `promptDecision: true,`. Rerun `npm run session:s11`: `Project trusted` becomes true and `Extensions loaded` becomes 1 — same repo, and whether a human can be asked directly decides whether extensions load.

2. Walk through the prefix check with your own hands: at the end of `demo()`, add

   ```ts
   console.log(await containedEnv.runBash("npm test; rm -rf /tmp/x", "/repo"));
   ```

   Rerun and watch it print `contained:/repo$ npm test; rm -rf /tmp/x` — it passed. (The env is an in-memory demo; `runBash` only echoes the command and never executes it, so play freely.) Then try a variant that doesn't start with `npm ` and confirm it gets stopped by `command blocked`. The conclusion arrives by your own hand: a prefix check stops honest commands but can't stop a semicolon — it is not a security boundary.

3. Add a write allowlist to the contained env: add `allowedWritePrefixes` to `ContainedExecutionEnvOptions`, check it in `writeFile`, and watch writes outside `/repo/src/` get rejected. When you're done, think about it: this allowlist is an in-process check just like the bash prefix — you can stack policy on the socket all you like, and the isolation strength won't climb a single step.

After changes, `npm run test:s11` confirms this unit's behavioral contract is intact.

## Wiring into the main line

| Component | Previous unit (s10) | This unit |
| --- | --- | --- |
| Project inputs | runtime default resources in place; nobody asks "may this load" | `resolveProjectTrusted()` + `loadProjectInputs()`: `.pi` inputs pass the trust gate, context files don't |
| mode | five shells were just I/O shapes | mode joins the trust decision: non-interactive can't ask, so ask falls straight to not loading |
| Tool execution | the core is an echo stub, never touches files | the `ExecutionEnv` interface: read / write / bash become a swappable backend |
| Security boundary | not discussed | trust governs inputs, env governs execution, strong isolation lives outside the process |

## Against the Pi source

Read [pi-source.md](pi-source.md) after this unit. For this one, enter through the docs rather than the source: the Project Trust, No Built-in Sandbox, and Running Untrusted or Unmonitored Work sections of `docs/security.md` lay out Pi's security model in full. Then read `resolveProjectTrusted()` in `project-trust.ts` — the decision order matches this unit, except that for the non-interactive test Pi actually checks hasUI — and the operations interfaces of read/write/bash: Pi didn't write a sandbox into the core; it made the execution backend swappable. Line-by-line anchors are in pi-source.md.

## Next up

Trust decides which project inputs may load; the execution env decides which backend tools land on. The outer layer is missing one last piece: how extensions, skills, prompts, and themes get packaged up and installed for someone else to use.

[s12 Pi Package](../s12_pi_package/README.md): a package isn't a new capability, just a unit of distribution — and project packages still pass through the same trust gate.
