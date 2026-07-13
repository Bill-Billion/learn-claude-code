import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

export type MiniFiles = Record<string, string>;

export type AppMode = "interactive" | "print" | "json" | "rpc";

export type DefaultProjectTrust = "ask" | "always" | "never";

export type ProjectTrustDecision = boolean | null;

export type ProjectTrustExtensionDecision = {
  trusted: "yes" | "no" | "undecided";
  remember?: boolean;
};

export type ResolveProjectTrustOptions = {
  files: MiniFiles;
  cwd: string;
  mode: AppMode;
  trustStore: MiniTrustStore;
  trustOverride?: boolean;
  defaultProjectTrust?: DefaultProjectTrust;
  promptDecision?: boolean;
  extensionDecision?: ProjectTrustExtensionDecision;
};

export type LoadedProjectInputs = {
  contextFiles: string[];
  projectSettingsLoaded: boolean;
  extensionPaths: string[];
  promptPaths: string[];
};

export type ExecutionEnv = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  runBash(command: string, cwd: string): Promise<string>;
};

export type ContainedExecutionEnvOptions = {
  root: string;
  allowedBashPrefixes: string[];
};

type TrustFile = Record<string, boolean | null | undefined>;

export class MiniTrustStore {
  private readonly decisions: TrustFile;

  constructor(initialDecisions: TrustFile = {}) {
    this.decisions = {};
    for (const [path, decision] of Object.entries(initialDecisions)) {
      this.set(path, decision ?? null);
    }
  }

  get(cwd: string): ProjectTrustDecision {
    let current = normalizePath(cwd);

    while (true) {
      const decision = this.decisions[current];
      if (decision === true || decision === false) {
        return decision;
      }

      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  set(cwd: string, decision: ProjectTrustDecision): void {
    const key = normalizePath(cwd);
    if (decision === null) {
      delete this.decisions[key];
    } else {
      this.decisions[key] = decision;
    }
  }

  entries(): Record<string, boolean | null> {
    const entries: Record<string, boolean | null> = {};
    for (const key of Object.keys(this.decisions).sort()) {
      const decision = this.decisions[key];
      if (decision === true || decision === false || decision === null) {
        entries[key] = decision;
      }
    }
    return entries;
  }
}

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

function readFromState(state: MiniFiles, path: string): string {
  const normalizedPath = normalizePath(path);
  const content = state[normalizedPath];
  if (content === undefined) {
    throw new Error(`file not found: ${normalizedPath}`);
  }
  return content;
}

function cloneFiles(files: MiniFiles): MiniFiles {
  const cloned: MiniFiles = {};
  for (const [path, content] of Object.entries(files)) {
    cloned[normalizePath(path)] = content;
  }
  return cloned;
}

function hasFile(files: MiniFiles, path: string): boolean {
  return Object.hasOwn(cloneFiles(files), normalizePath(path));
}

function hasDirectory(files: MiniFiles, dir: string): boolean {
  const normalizedDir = stripTrailingSlash(normalizePath(dir));
  return Object.keys(files).some((path) => normalizePath(path).startsWith(`${normalizedDir}/`));
}

function listFilesUnder(files: MiniFiles, dir: string): string[] {
  const normalizedDir = stripTrailingSlash(normalizePath(dir));
  return Object.keys(files)
    .map(normalizePath)
    .filter((path) => path.startsWith(`${normalizedDir}/`))
    .sort();
}

function assertInsideRoot(path: string, root: string): void {
  const normalizedPath = normalizePath(path);
  const rel = relative(root, normalizedPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`outside contained root: ${normalizedPath}`);
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.join(sep));
}

function normalizePath(path: string): string {
  return normalize(resolve(path)).replaceAll("\\", "/");
}

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

async function demo(): Promise<void> {
  const files = {
    "/repo/AGENTS.md": "Project context.",
    "/repo/.pi/settings.json": "{}",
    "/repo/.pi/extensions/guard.ts": "export default function guard() {}",
    "/repo/secret.txt": "token",
  };
  const store = new MiniTrustStore();
  const trusted = await resolveProjectTrusted({
    files,
    cwd: "/repo",
    mode: "print",
    defaultProjectTrust: "ask",
    trustStore: store,
  });
  const inputs = loadProjectInputs(files, "/repo", trusted);
  const localEnv = createLocalExecutionEnv(files);
  const containedEnv = createContainedExecutionEnv(files, { root: "/repo", allowedBashPrefixes: ["npm "] });

  console.log(`Project trusted: ${trusted}`);
  console.log(`Context files: ${inputs.contextFiles.join(", ") || "(none)"}`);
  console.log(`Extensions loaded: ${inputs.extensionPaths.length}`);
  console.log(`Local read still works: ${await localEnv.readFile("/repo/secret.txt")}`);
  console.log(`Contained bash: ${await containedEnv.runBash("npm test", "/repo")}`);
}

if (process.argv.includes("--demo")) {
  await demo();
}
