import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { createCourseToolRegistry } from "../s02_tool_schema/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";
import { createFileSystemResourceSource } from "../s08_context_resources/code.ts";
import { loadMiniExtensions } from "../s09_extension_runtime/code.ts";
import {
  createMiniCoreRuntime,
  runPrintMode,
  type MiniCoreRuntime,
  type MiniCoreRuntimeOptions,
} from "../s10_runtime_modes/code.ts";
import { isMainModule, parsePromptArguments, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";

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
  skillPaths: string[];
  extensionPaths: string[];
  promptPaths: string[];
  packagePaths: string[];
};

export type PreparedProjectTrust = {
  projectTrusted: boolean;
  projectInputs: LoadedProjectInputs;
};

export type CreateProjectTrustRuntimeOptions = ResolveProjectTrustOptions & {
  runtimeOptions: MiniCoreRuntimeOptions;
};

export type ProjectTrustRuntime = PreparedProjectTrust & {
  runtime: MiniCoreRuntime;
};

type TrustFile = Record<string, boolean | null | undefined>;
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

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
      if (decision === true || decision === false) return decision;

      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  set(cwd: string, decision: ProjectTrustDecision): void {
    const key = normalizePath(cwd);
    if (decision === null) delete this.decisions[key];
    else this.decisions[key] = decision;
  }

  entries(): Record<string, boolean | null> {
    const entries: Record<string, boolean | null> = {};
    for (const key of Object.keys(this.decisions).sort()) {
      const decision = this.decisions[key];
      if (decision === true || decision === false || decision === null) entries[key] = decision;
    }
    return entries;
  }
}

export function hasProjectTrustInputs(files: MiniFiles, cwd: string): boolean {
  const normalizedCwd = normalizePath(cwd);
  if (hasDirectory(files, joinPath(normalizedCwd, ".pi"))) return true;

  return ancestorDirs(normalizedCwd).some((dir) => hasDirectory(files, joinPath(dir, ".agents", "skills")));
}

export async function resolveProjectTrusted(options: ResolveProjectTrustOptions): Promise<boolean> {
  if (options.trustOverride !== undefined) return options.trustOverride;
  if (!hasProjectTrustInputs(options.files, options.cwd)) return true;

  if (options.extensionDecision && options.extensionDecision.trusted !== "undecided") {
    const trusted = options.extensionDecision.trusted === "yes";
    if (options.extensionDecision.remember === true) options.trustStore.set(options.cwd, trusted);
    return trusted;
  }

  const storedDecision = options.trustStore.get(options.cwd);
  if (storedDecision !== null) return storedDecision;

  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return true;
    case "never":
      return false;
    case "ask":
      break;
  }

  if (options.mode !== "interactive") return false;
  return options.promptDecision === true;
}

export function loadProjectInputs(files: MiniFiles, cwd: string, projectTrusted: boolean): LoadedProjectInputs {
  const normalizedCwd = normalizePath(cwd);
  const contextFiles = ancestorDirs(normalizedCwd)
    .map((dir) => findContextFile(files, dir))
    .filter((path): path is string => path !== undefined);

  if (!projectTrusted) {
    return {
      contextFiles,
      projectSettingsLoaded: false,
      skillPaths: [],
      extensionPaths: [],
      promptPaths: [],
      packagePaths: [],
    };
  }

  return {
    contextFiles,
    projectSettingsLoaded: hasFile(files, joinPath(normalizedCwd, ".pi", "settings.json")),
    skillPaths: ancestorDirs(normalizedCwd).flatMap((dir) =>
      listFilesUnder(files, joinPath(dir, ".agents", "skills")).filter((path) => /\/SKILL\.md$/i.test(path)),
    ),
    extensionPaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "extensions")),
    promptPaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "prompts")).filter((path) => /\.md$/i.test(path)),
    packagePaths: listFilesUnder(files, joinPath(normalizedCwd, ".pi", "packages")),
  };
}

export async function prepareProjectTrust(options: ResolveProjectTrustOptions): Promise<PreparedProjectTrust> {
  const projectTrusted = await resolveProjectTrusted(options);
  return {
    projectTrusted,
    projectInputs: loadProjectInputs(options.files, options.cwd, projectTrusted),
  };
}

export async function createProjectTrustRuntime(
  options: CreateProjectTrustRuntimeOptions,
): Promise<ProjectTrustRuntime> {
  const prepared = await prepareProjectTrust(options);
  const runtime = await createMiniCoreRuntime({
    ...options.runtimeOptions,
    skillFiles: unique([
      ...(options.runtimeOptions.skillFiles ?? []),
      ...prepared.projectInputs.skillPaths,
    ]),
    promptTemplateFiles: unique([
      ...(options.runtimeOptions.promptTemplateFiles ?? []),
      ...prepared.projectInputs.promptPaths,
    ]),
  });
  return { ...prepared, runtime };
}

export async function discoverProjectTrustFiles(cwd: string): Promise<MiniFiles> {
  const files: MiniFiles = {};
  const normalizedCwd = normalizePath(cwd);
  for (const dir of ancestorDirs(normalizedCwd)) {
    for (const name of CONTEXT_FILE_NAMES) await addFileKey(files, join(dir, name));
    await addDirectoryFileKeys(files, join(dir, ".agents", "skills"));
  }
  await addDirectoryFileKeys(files, join(normalizedCwd, ".pi"));
  return files;
}

function findContextFile(files: MiniFiles, dir: string): string | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = joinPath(dir, name);
    if (hasFile(files, path)) return path;
  }
  return undefined;
}

function hasFile(files: MiniFiles, path: string): boolean {
  const normalizedPath = normalizePath(path);
  return Object.keys(files).some((candidate) => normalizePath(candidate) === normalizedPath);
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

function ancestorDirs(path: string): string[] {
  const dirs: string[] = [];
  let current = normalizePath(path);
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
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

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function addFileKey(files: MiniFiles, path: string): Promise<void> {
  try {
    const entries = await readdir(dirname(path));
    if (entries.includes(path.slice(path.lastIndexOf(sep) + 1))) files[normalizePath(path)] = "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function addDirectoryFileKeys(files: MiniFiles, root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await addDirectoryFileKeys(files, path);
    else if (entry.isFile()) files[normalizePath(path)] = "";
  }
}

export function parseDefaultProjectTrust(value: string | undefined): DefaultProjectTrust {
  return value === "always" || value === "never" ? value : "ask";
}

async function runLiveCli(): Promise<void> {
  const courseModel = loadCourseModel();
  const cwd = process.cwd();
  const files = await discoverProjectTrustFiles(cwd);
  const prepared = await createProjectTrustRuntime({
    files,
    cwd,
    mode: parsePromptArguments() ? "print" : "interactive",
    trustStore: new MiniTrustStore(),
    defaultProjectTrust: parseDefaultProjectTrust(process.env.PI_PROJECT_TRUST),
    runtimeOptions: {
      runner: await loadMiniExtensions([]),
      source: createFileSystemResourceSource(),
      cwd,
      agentDir: process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
      session: createSessionTree({ cwd }),
      model: courseModel.model,
      registry: createCourseToolRegistry(cwd),
      activeToolNames: ["read_file"],
      streamOptions: courseModel.streamOptions,
    },
  });
  await runPromptCli("s11 Project Trust", (prompt) => runPrintMode(prepared.runtime, prompt));
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
