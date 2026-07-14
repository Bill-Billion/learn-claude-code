import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

import type { Api, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";

import { createCourseToolRegistry, type ToolRegistry } from "../s02_tool_schema/code.ts";
import type { AgentMessage, MiniSession } from "../s06_turn_state/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";
import { createFileSystemResourceSource, type ResourceSource } from "../s08_context_resources/code.ts";
import type { MiniExtensionFactory, MiniExtensionSource } from "../s09_extension_runtime/code.ts";
import {
  runPrintMode,
  type MiniCoreRuntime,
  type MiniRunResult,
  type MiniRuntime,
  type MiniRuntimeState,
} from "../s10_runtime_modes/code.ts";
import {
  MiniTrustStore,
  discoverProjectTrustFiles,
  parseDefaultProjectTrust,
  prepareProjectTrust,
  type AppMode,
  type DefaultProjectTrust,
  type LoadedProjectInputs,
  type ProjectTrustExtensionDecision,
} from "../s11_project_trust/code.ts";
import {
  createPackageRuntime,
  discoverExtensionEntries,
  type PackageEntry,
  type PackageRuntime,
  type ResolvedPackageResources,
} from "../s12_pi_package/code.ts";
import { isMainModule, parsePromptArguments, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";

export type IntegratedTrustOptions = {
  mode?: AppMode;
  trustOverride?: boolean;
  defaultProjectTrust?: DefaultProjectTrust;
  promptDecision?: boolean;
  extensionDecision?: ProjectTrustExtensionDecision;
};

export type IntegratedHarnessOptions = {
  files: Record<string, string>;
  source?: ResourceSource;
  cwd: string;
  agentDir: string;
  model: Model<Api>;
  registry: ToolRegistry;
  session?: MiniSession<AgentMessage>;
  streamOptions?: ProviderStreamOptions;
  activeToolNames?: string[];
  userPackages?: PackageEntry[];
  projectPackages?: PackageEntry[];
  userExtensionPaths?: string[];
  userSkillPaths?: string[];
  userPromptPaths?: string[];
  extensionFactories?: Readonly<Record<string, MiniExtensionFactory>>;
  trustStore?: MiniTrustStore;
  trust?: IntegratedTrustOptions;
  maxTurns?: number;
};

export class IntegratedHarnessRuntime implements MiniRuntime {
  readonly projectTrusted: boolean;
  readonly projectInputs: LoadedProjectInputs;
  readonly packageResources: ResolvedPackageResources;

  private readonly core: MiniCoreRuntime;
  private readonly invokePackagePromptTemplate: PackageRuntime["invokePromptTemplate"];
  private promptQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    core: MiniCoreRuntime;
    invokePackagePromptTemplate: PackageRuntime["invokePromptTemplate"];
    projectTrusted: boolean;
    projectInputs: LoadedProjectInputs;
    packageResources: ResolvedPackageResources;
  }) {
    this.core = options.core;
    this.invokePackagePromptTemplate = options.invokePackagePromptTemplate;
    this.projectTrusted = options.projectTrusted;
    this.projectInputs = structuredClone(options.projectInputs);
    this.packageResources = structuredClone(options.packageResources);
  }

  prompt(prompt: string): Promise<MiniRunResult> {
    return this.enqueuePrompt(() => this.core.prompt(prompt));
  }

  invokePromptTemplate(name: string, args: string[] = []): Promise<MiniRunResult> {
    return this.enqueuePrompt(() => this.invokePackagePromptTemplate(name, args));
  }

  private enqueuePrompt(operation: () => Promise<MiniRunResult>): Promise<MiniRunResult> {
    const result = this.promptQueue.then(operation);
    this.promptQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  getState(): MiniRuntimeState {
    return this.core.getState();
  }

  subscribe(listener: Parameters<MiniRuntime["subscribe"]>[0]): () => void {
    return this.core.subscribe(listener);
  }
}

export async function createIntegratedHarnessRuntime(
  options: IntegratedHarnessOptions,
): Promise<IntegratedHarnessRuntime> {
  const trust = options.trust ?? {};
  const preparedTrust = await prepareProjectTrust({
    files: options.files,
    cwd: options.cwd,
    mode: trust.mode ?? "print",
    trustStore: options.trustStore ?? new MiniTrustStore(),
    trustOverride: trust.trustOverride,
    defaultProjectTrust: trust.defaultProjectTrust,
    promptDecision: trust.promptDecision,
    extensionDecision: trust.extensionDecision,
  });
  const directProjectExtensionPaths = preparedTrust.projectTrusted
    ? discoverExtensionEntries(options.files, join(options.cwd, ".pi", "extensions"))
    : [];
  const factories = options.extensionFactories ?? {};
  const additionalExtensionSources = toExtensionSources(
    unique([...(options.userExtensionPaths ?? []), ...directProjectExtensionPaths]),
    factories,
  );
  const packageRuntime = await createPackageRuntime({
    files: options.files,
    userPackages: options.userPackages ?? [],
    projectPackages: options.projectPackages ?? [],
    projectTrusted: preparedTrust.projectTrusted,
    cwd: options.cwd,
    agentDir: options.agentDir,
    extensionSources: Object.entries(factories).map(([path, factory]) => ({ path, factory })),
    additionalExtensionSources,
    additionalSkillPaths: unique([
      ...(options.userSkillPaths ?? []),
      ...preparedTrust.projectInputs.skillPaths,
    ]),
    additionalPromptPaths: unique([
      ...(options.userPromptPaths ?? []),
      ...preparedTrust.projectInputs.promptPaths,
    ]),
    runtimeOptions: {
      source: options.source ?? createMemoryResourceSource(options.files),
      cwd: options.cwd,
      agentDir: options.agentDir,
      session: options.session ?? createSessionTree({ cwd: options.cwd }),
      model: options.model,
      registry: options.registry,
      activeToolNames: options.activeToolNames,
      streamOptions: options.streamOptions,
      maxTurns: options.maxTurns,
    },
  });

  return new IntegratedHarnessRuntime({
    core: packageRuntime.runtime,
    invokePackagePromptTemplate: packageRuntime.invokePromptTemplate,
    projectTrusted: preparedTrust.projectTrusted,
    projectInputs: preparedTrust.projectInputs,
    packageResources: packageRuntime.resources,
  });
}

function toExtensionSources(
  paths: string[],
  factories: Readonly<Record<string, MiniExtensionFactory>>,
): MiniExtensionSource[] {
  const normalizedFactories = new Map(
    Object.entries(factories).map(([path, factory]) => [normalizePath(path), factory] as const),
  );
  return paths.map((path) => {
    const factory = normalizedFactories.get(normalizePath(path));
    if (!factory) throw new Error(`Missing extension factory: ${path}`);
    return { path, factory };
  });
}

function createMemoryResourceSource(files: Record<string, string>): ResourceSource {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, content]) => [normalizePath(path), content] as const),
  );
  return {
    readText(path) {
      return normalizedFiles.get(normalizePath(path));
    },
  };
}

function normalizePath(path: string): string {
  return normalize(resolve(path)).replaceAll("\\", "/");
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function runLiveCli(): Promise<void> {
  const courseModel = loadCourseModel();
  const cwd = process.cwd();
  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const runtime = await createIntegratedHarnessRuntime({
    files: await discoverProjectTrustFiles(cwd),
    source: createFileSystemResourceSource(),
    cwd,
    agentDir,
    model: courseModel.model,
    registry: createCourseToolRegistry(cwd),
    session: createSessionTree({ cwd }),
    streamOptions: courseModel.streamOptions,
    activeToolNames: ["read_file"],
    trust: {
      mode: parsePromptArguments() ? "print" : "interactive",
      defaultProjectTrust: parseDefaultProjectTrust(process.env.PI_PROJECT_TRUST),
    },
  });
  await runPromptCli("s13 Integrated Harness", (prompt) => runPrintMode(runtime, prompt));
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
