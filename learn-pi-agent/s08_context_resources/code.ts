import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import { createCourseToolRegistry, type ToolRegistry } from "../s02_tool_schema/code.ts";
import type { ToolHooks } from "../s05_tool_hooks/code.ts";
import {
  createMiniHarness,
  runHarnessTurn,
  type AgentMessage,
  type MiniHarnessOptions,
  type MiniPromptTemplate,
  type MiniSession,
  type MiniSkill,
  type RunHarnessTurnResult,
  type TransformContext,
  type TurnState,
} from "../s06_turn_state/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";

export type ResourceSource = {
  readText(path: string): string | undefined | Promise<string | undefined>;
};

export type ContextFile = {
  path: string;
  content: string;
};

export type ContextSkill = MiniSkill & {
  content: string;
  filePath: string;
  disableModelInvocation: boolean;
};

export type ContextPromptTemplate = MiniPromptTemplate & {
  description: string;
  filePath: string;
};

export type ContextResources = {
  contextFiles: ContextFile[];
  skills: ContextSkill[];
  promptTemplates: ContextPromptTemplate[];
};

export type LoadContextResourcesOptions = {
  source: ResourceSource;
  cwd: string;
  agentDir: string;
  skillFiles?: string[];
  promptTemplateFiles?: string[];
};

export type BuildContextSystemPromptOptions = {
  cwd: string;
  activeToolNames: string[];
  contextFiles: ContextFile[];
  skills: ContextSkill[];
};

export type CreateContextResourceTurnStateOptions = LoadContextResourcesOptions & {
  session: MiniSession<AgentMessage>;
  model: Model<Api>;
  registry: ToolRegistry;
  activeToolNames?: string[];
  streamOptions?: MiniHarnessOptions["streamOptions"];
  transformContext?: TransformContext;
};

export type ContextResourceTurnState = TurnState & {
  contextFiles: ContextFile[];
};

export type RunContextResourceTurnOptions = CreateContextResourceTurnStateOptions & {
  prompt: string;
  hooks?: ToolHooks;
  maxTurns?: number;
  onEvent?: Parameters<typeof runHarnessTurn>[0]["onEvent"];
};

export type RunContextResourceTurnResult = RunHarnessTurnResult & {
  contextResources: ContextResources;
};

export type PreparedContextResources = {
  contextResources: ContextResources;
  harnessResources: NonNullable<MiniHarnessOptions["resources"]>;
  systemPrompt: MiniHarnessOptions["systemPrompt"];
};

export function createFileSystemResourceSource(): ResourceSource {
  return {
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}

export async function loadContextResources(options: LoadContextResourcesOptions): Promise<ContextResources> {
  const skills: ContextSkill[] = [];
  for (const filePath of options.skillFiles ?? []) {
    skills.push(await loadSkill(options.source, filePath));
  }
  const promptTemplates: ContextPromptTemplate[] = [];
  for (const filePath of options.promptTemplateFiles ?? []) {
    promptTemplates.push(await loadPromptTemplate(options.source, filePath));
  }
  return {
    contextFiles: await loadProjectContextFiles(options.source, options.cwd, options.agentDir),
    skills,
    promptTemplates,
  };
}

export function buildContextSystemPrompt(options: BuildContextSystemPromptOptions): string {
  const lines = [
    "You are a coding assistant running inside mini pi.",
    "",
    `Current working directory: ${options.cwd}`,
  ];
  if (options.contextFiles.length > 0) {
    lines.push("", "<project_context>", "");
    for (const file of options.contextFiles) {
      lines.push(`<project_instructions path="${escapeXml(file.path)}">`);
      lines.push(file.content);
      lines.push("</project_instructions>", "");
    }
    lines.push("</project_context>");
  }
  if (options.activeToolNames.some((name) => name === "read" || name === "read_file")) {
    const skillsBlock = formatSkillsForSystemPrompt(options.skills);
    if (skillsBlock) lines.push("", skillsBlock);
  }
  return lines.join("\n");
}

export function formatSkillsForSystemPrompt(skills: ContextSkill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatPromptTemplateInvocation(template: ContextPromptTemplate, args: string[] = []): string {
  const allArgs = args.join(" ");
  return template.content.replace(/\$(ARGUMENTS|@|\d+)/g, (_match, token: string) => {
    if (token === "ARGUMENTS" || token === "@") return allArgs;
    return args[Number(token) - 1] ?? "";
  });
}

export async function createContextResourceTurnState(
  options: CreateContextResourceTurnStateOptions,
): Promise<ContextResourceTurnState> {
  const prepared = await prepareContextResources(options);
  const turnState = await createMiniHarness({
    session: options.session,
    model: options.model,
    registry: options.registry,
    activeToolNames: options.activeToolNames,
    streamOptions: options.streamOptions,
    transformContext: options.transformContext,
    resources: prepared.harnessResources,
    systemPrompt: prepared.systemPrompt,
  }).createTurnState();
  return {
    ...turnState,
    contextFiles: prepared.contextResources.contextFiles.map((file) => ({ ...file })),
  };
}

export async function runContextResourceTurn(
  options: RunContextResourceTurnOptions,
): Promise<RunContextResourceTurnResult> {
  const prepared = await prepareContextResources(options);
  const result = await runHarnessTurn({
    session: options.session,
    model: options.model,
    registry: options.registry,
    activeToolNames: options.activeToolNames,
    streamOptions: options.streamOptions,
    transformContext: options.transformContext,
    resources: prepared.harnessResources,
    systemPrompt: prepared.systemPrompt,
    prompt: options.prompt,
    hooks: options.hooks,
    maxTurns: options.maxTurns,
    onEvent: options.onEvent,
  });
  return { ...result, contextResources: cloneContextResources(prepared.contextResources) };
}

export async function prepareContextResources(
  options: CreateContextResourceTurnStateOptions,
): Promise<PreparedContextResources> {
  const contextResources = await loadContextResources(options);
  const harnessResources = {
    skills: contextResources.skills.map(({ name, description }) => ({ name, description })),
    promptTemplates: contextResources.promptTemplates.map(({ name, description, content }) => ({
      name,
      description,
      content,
    })),
  };
  const systemPrompt: MiniHarnessOptions["systemPrompt"] = ({ activeTools }) => buildContextSystemPrompt({
    cwd: options.cwd,
    activeToolNames: activeTools.map((tool) => tool.name),
    contextFiles: contextResources.contextFiles,
    skills: contextResources.skills,
  });
  return { contextResources, harnessResources, systemPrompt };
}

async function loadProjectContextFiles(
  source: ResourceSource,
  cwd: string,
  agentDir: string,
): Promise<ContextFile[]> {
  const result: ContextFile[] = [];
  const seen = new Set<string>();
  const globalFile = await findContextFile(source, agentDir);
  if (globalFile) {
    result.push(globalFile);
    seen.add(globalFile.path);
  }
  for (const dir of ancestorDirs(cwd)) {
    const file = await findContextFile(source, dir);
    if (file && !seen.has(file.path)) {
      result.push(file);
      seen.add(file.path);
    }
  }
  return result;
}

async function findContextFile(source: ResourceSource, dir: string): Promise<ContextFile | undefined> {
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const path = joinPath(dir, name);
    const content = await source.readText(path);
    if (content !== undefined) return { path, content };
  }
  return undefined;
}

async function loadSkill(source: ResourceSource, filePath: string): Promise<ContextSkill> {
  const parsed = parseFrontmatter(await readRequired(source, filePath));
  const name = String(parsed.frontmatter.name ?? basename(dirname(filePath)));
  const description = String(parsed.frontmatter.description ?? "").trim();
  if (!description) throw new Error(`Skill ${filePath} is missing description`);
  return {
    name,
    description,
    content: parsed.body,
    filePath,
    disableModelInvocation: parsed.frontmatter["disable-model-invocation"] === true,
  };
}

async function loadPromptTemplate(source: ResourceSource, filePath: string): Promise<ContextPromptTemplate> {
  const parsed = parseFrontmatter(await readRequired(source, filePath));
  const firstLine = parsed.body.split("\n").find((line) => line.trim()) ?? "";
  return {
    name: basename(filePath).replace(/\.md$/i, ""),
    description: String(parsed.frontmatter.description ?? firstLine.slice(0, 60)),
    content: parsed.body,
    filePath,
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string | boolean>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized.trim() };
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return { frontmatter: {}, body: normalized.trim() };
  const frontmatter: Record<string, string | boolean> = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    frontmatter[key] = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
  }
  return { frontmatter, body: normalized.slice(endIndex + 4).trim() };
}

function ancestorDirs(cwd: string): string[] {
  const normalized = normalizePath(cwd);
  const parts = normalized.split("/").filter(Boolean);
  const dirs: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    dirs.push(current);
  }
  return dirs;
}

async function readRequired(source: ResourceSource, path: string): Promise<string> {
  const content = await source.readText(path);
  if (content === undefined) throw new Error(`Missing file: ${path}`);
  return content;
}

function joinPath(dir: string, name: string): string {
  return `${normalizePath(dir).replace(/\/$/, "")}/${name}`;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized === "/" ? "/" : normalized.replace(/\/$/, "");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cloneContextResources(resources: ContextResources): ContextResources {
  return structuredClone(resources);
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const cwd = process.cwd();
  const session = createSessionTree({ cwd });
  const registry = createCourseToolRegistry(cwd);
  const source = createFileSystemResourceSource();
  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  await runPromptCli("s08 Context Resources", async (prompt) => {
    const result = await runContextResourceTurn({
      source,
      cwd,
      agentDir,
      session,
      model: runtime.model,
      registry,
      activeToolNames: ["read_file"],
      streamOptions: runtime.streamOptions,
      prompt,
    });
    return result.finalMessage.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
