import assert from "node:assert/strict";
import test from "node:test";

import { createDemoToolRegistry } from "../s02_tool_schema/code.ts";
import { createDemoSession, type MiniModel } from "../s06_turn_state/code.ts";
import {
  buildContextSystemPrompt,
  createContextResourceTurnState,
  formatPromptTemplateInvocation,
  loadContextResources,
  type MemoryFiles,
} from "./code.ts";

const model: MiniModel = {
  provider: "demo",
  id: "demo-model",
};

function createFiles(): MemoryFiles {
  return {
    "/home/me/.pi/agent/AGENTS.md": "Global instruction.",
    "/work/AGENTS.md": "Workspace instruction.",
    "/work/app/CLAUDE.md": "App instruction.",
    "/work/app/.pi/skills/review/SKILL.md": [
      "---",
      "name: review",
      "description: Review code changes.",
      "---",
      "Read the diff before commenting.",
    ].join("\n"),
    "/work/app/.pi/skills/private/SKILL.md": [
      "---",
      "name: private",
      "description: Hidden from the model.",
      "disable-model-invocation: true",
      "---",
      "Only invoke this explicitly.",
    ].join("\n"),
    "/work/app/.pi/prompts/fix.md": [
      "---",
      "description: Fix a target file.",
      "---",
      "Fix $1 with focus on $@.",
    ].join("\n"),
  };
}

test("loadContextResources collects context files, skills, and prompt templates", () => {
  const resources = loadContextResources({
    files: createFiles(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md", "/work/app/.pi/skills/private/SKILL.md"],
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  assert.deepEqual(
    resources.contextFiles.map((file) => file.path),
    ["/home/me/.pi/agent/AGENTS.md", "/work/AGENTS.md", "/work/app/CLAUDE.md"],
  );
  assert.deepEqual(resources.skills.map((skill) => [skill.name, skill.description, skill.disableModelInvocation]), [
    ["review", "Review code changes.", false],
    ["private", "Hidden from the model.", true],
  ]);
  assert.deepEqual(resources.promptTemplates.map((template) => [template.name, template.description]), [
    ["fix", "Fix a target file."],
  ]);
});

test("buildContextSystemPrompt renders context files and only model-visible skills", () => {
  const resources = loadContextResources({
    files: createFiles(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md", "/work/app/.pi/skills/private/SKILL.md"],
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  const prompt = buildContextSystemPrompt({
    cwd: "/work/app",
    activeToolNames: ["read", "bash"],
    contextFiles: resources.contextFiles,
    skills: resources.skills,
  });

  assert.match(prompt, /<project_instructions path="\/home\/me\/\.pi\/agent\/AGENTS\.md">/);
  assert.match(prompt, /Workspace instruction\./);
  assert.match(prompt, /App instruction\./);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /<name>review<\/name>/);
  assert.doesNotMatch(prompt, /<name>private<\/name>/);
  assert.doesNotMatch(prompt, /Fix a target file/);

  const noReadPrompt = buildContextSystemPrompt({
    cwd: "/work/app",
    activeToolNames: ["bash"],
    contextFiles: resources.contextFiles,
    skills: resources.skills,
  });

  assert.doesNotMatch(noReadPrompt, /<available_skills>/);
});

test("formatPromptTemplateInvocation expands positional and rest arguments", () => {
  const resources = loadContextResources({
    files: createFiles(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  assert.equal(
    formatPromptTemplateInvocation(resources.promptTemplates[0]!, ["README.md", "edge cases"]),
    "Fix README.md with focus on README.md edge cases.",
  );
});

test("formatPromptTemplateInvocation does not substitute placeholders inside argument values", () => {
  const template = {
    name: "fix",
    description: "recursion guard",
    filePath: "/work/app/.pi/prompts/fix.md",
    content: "Fix $1 then $ARGUMENTS.",
  };

  assert.equal(
    formatPromptTemplateInvocation(template, ["$ARGUMENTS", "$2"]),
    "Fix $ARGUMENTS then $ARGUMENTS $2.",
  );
});

test("createContextResourceTurnState connects loaded resources to the s06 turn state shape", async () => {
  const turnState = await createContextResourceTurnState({
    files: createFiles(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createDemoSession("s08", [{ role: "user", content: "Use project rules." }]),
    model,
    registry: createDemoToolRegistry(),
    activeToolNames: ["read"],
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md"],
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  assert.equal(turnState.sessionId, "s08");
  assert.deepEqual(turnState.messages.map((message) => message.content), ["Use project rules."]);
  assert.deepEqual(
    turnState.resources.promptTemplates?.map((template) => [template.name, template.description]),
    [["fix", "Fix a target file."]],
  );
  assert.deepEqual(turnState.contextFiles.map((file) => file.path), [
    "/home/me/.pi/agent/AGENTS.md",
    "/work/AGENTS.md",
    "/work/app/CLAUDE.md",
  ]);
  assert.match(turnState.systemPrompt, /Global instruction\./);
  assert.match(turnState.systemPrompt, /<name>review<\/name>/);
});
