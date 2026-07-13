import { createDemoToolRegistry, type ToolRegistry } from "../s02_tool_schema/code.ts";
import {
  createDemoSession,
  createMiniHarness,
  type MiniHarnessOptions,
  type MiniMessage,
  type MiniModel,
  type MiniPromptTemplate,
  type MiniSession,
  type MiniSkill,
  type TurnState,
} from "../s06_turn_state/code.ts";

export type MemoryFiles = Record<string, string>;

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
  files: MemoryFiles;
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
  session: MiniSession;
  model: MiniModel;
  registry: ToolRegistry;
  activeToolNames?: string[];
};

export type ContextResourceTurnState = TurnState & {
  contextFiles: ContextFile[];
};

export function loadContextResources(options: LoadContextResourcesOptions): ContextResources {
  return {
    contextFiles: loadProjectContextFiles(options.files, options.cwd, options.agentDir),
    skills: (options.skillFiles ?? []).map((filePath) => loadSkill(options.files, filePath)),
    promptTemplates: (options.promptTemplateFiles ?? []).map((filePath) => loadPromptTemplate(options.files, filePath)),
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

  if (options.activeToolNames.includes("read")) {
    const skillsBlock = formatSkillsForSystemPrompt(options.skills);
    if (skillsBlock) {
      lines.push("", skillsBlock);
    }
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
  // Single pass over the template, like Pi: argument values that contain
  // $1, $@, or $ARGUMENTS are NOT recursively substituted.
  return template.content.replace(/\$(ARGUMENTS|@|\d+)/g, (_match, token: string) => {
    if (token === "ARGUMENTS" || token === "@") return allArgs;
    return args[Number(token) - 1] ?? "";
  });
}

export async function createContextResourceTurnState(
  options: CreateContextResourceTurnStateOptions,
): Promise<ContextResourceTurnState> {
  const contextResources = loadContextResources(options);
  const harness = createMiniHarness({
    session: options.session,
    model: options.model,
    registry: options.registry,
    activeToolNames: options.activeToolNames,
    resources: {
      skills: contextResources.skills.map(({ name, description }) => ({ name, description })),
      promptTemplates: contextResources.promptTemplates.map(({ name, description, content }) => ({
        name,
        description,
        content,
      })),
    },
    systemPrompt({ activeTools }) {
      return buildContextSystemPrompt({
        cwd: options.cwd,
        activeToolNames: activeTools.map((tool) => tool.name),
        contextFiles: contextResources.contextFiles,
        skills: contextResources.skills,
      });
    },
  } satisfies MiniHarnessOptions);

  const turnState = await harness.createTurnState();
  return {
    ...turnState,
    contextFiles: contextResources.contextFiles.map((file) => ({ ...file })),
  };
}

function loadProjectContextFiles(files: MemoryFiles, cwd: string, agentDir: string): ContextFile[] {
  const result: ContextFile[] = [];
  const seen = new Set<string>();

  const globalFile = findContextFile(files, agentDir);
  if (globalFile) {
    result.push(globalFile);
    seen.add(globalFile.path);
  }

  for (const dir of ancestorDirs(cwd)) {
    const file = findContextFile(files, dir);
    if (file && !seen.has(file.path)) {
      result.push(file);
      seen.add(file.path);
    }
  }

  return result;
}

function findContextFile(files: MemoryFiles, dir: string): ContextFile | undefined {
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const path = joinPath(dir, name);
    if (files[path] !== undefined) {
      return { path, content: files[path] };
    }
  }
  return undefined;
}

function loadSkill(files: MemoryFiles, filePath: string): ContextSkill {
  const raw = readRequired(files, filePath);
  const parsed = parseFrontmatter(raw);
  const name = String(parsed.frontmatter.name ?? basename(dirname(filePath)));
  const description = String(parsed.frontmatter.description ?? "").trim();
  if (!description) {
    throw new Error(`Skill ${filePath} is missing description`);
  }

  return {
    name,
    description,
    content: parsed.body,
    filePath,
    disableModelInvocation: parsed.frontmatter["disable-model-invocation"] === true,
  };
}

function loadPromptTemplate(files: MemoryFiles, filePath: string): ContextPromptTemplate {
  const raw = readRequired(files, filePath);
  const parsed = parseFrontmatter(raw);
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
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const frontmatter: Record<string, string | boolean> = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    frontmatter[key] = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
  }

  return {
    frontmatter,
    body: normalized.slice(endIndex + 4).trim(),
  };
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

function readRequired(files: MemoryFiles, path: string): string {
  const content = files[path];
  if (content === undefined) {
    throw new Error(`Missing file: ${path}`);
  }
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

export async function runDemo(): Promise<void> {
  const files: MemoryFiles = {
    "/home/me/.pi/agent/AGENTS.md": "Prefer small, verified changes.",
    "/work/pi/AGENTS.md": "Use the local test command before claiming success.",
    "/work/pi/.pi/skills/review/SKILL.md": [
      "---",
      "name: review",
      "description: Review a change before shipping it.",
      "---",
      "Read the diff and list concrete risks.",
    ].join("\n"),
    "/work/pi/.pi/prompts/fix.md": [
      "---",
      "description: Fix one file.",
      "---",
      "Fix $1 and explain the verification.",
    ].join("\n"),
  };

  const turnState = await createContextResourceTurnState({
    files,
    cwd: "/work/pi",
    agentDir: "/home/me/.pi/agent",
    session: createDemoSession("demo-session", [{ role: "user", content: "Review this change." }]),
    model: { provider: "demo", id: "demo-model" },
    registry: createDemoToolRegistry(),
    activeToolNames: ["read", "bash"],
    skillFiles: ["/work/pi/.pi/skills/review/SKILL.md"],
    promptTemplateFiles: ["/work/pi/.pi/prompts/fix.md"],
  });

  const promptTemplate = turnState.resources.promptTemplates?.[0] as ContextPromptTemplate | undefined;
  console.log(`Session: ${turnState.sessionId}`);
  console.log(`Context files: ${turnState.contextFiles.map((file) => basename(file.path)).join(", ")}`);
  console.log(`Skills in resources: ${turnState.resources.skills?.map((skill) => skill.name).join(", ")}`);
  console.log(`Prompt templates: ${turnState.resources.promptTemplates?.map((template) => template.name).join(", ")}`);
  console.log(`System prompt has skills: ${turnState.systemPrompt.includes("<available_skills>")}`);
  console.log(`Template expansion: ${promptTemplate ? formatPromptTemplateInvocation(promptTemplate, ["README.md"]) : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
