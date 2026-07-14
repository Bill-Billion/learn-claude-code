import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../s02_tool_schema/code.ts";
import { createMemorySession } from "../s06_turn_state/code.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";
import {
  buildContextSystemPrompt,
  createContextResourceTurnState,
  formatPromptTemplateInvocation,
  loadContextResources,
  runContextResourceTurn,
  type ResourceSource,
} from "./code.ts";

function createFiles(): Record<string, string> {
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

function memorySource(files = createFiles()): ResourceSource {
  return {
    async readText(path) {
      return files[path];
    },
  };
}

function createRegistry() {
  return createToolRegistry([{
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler(input) {
      return { toolName: "read_file", content: `contents of ${String(input.path)}` };
    },
  }]);
}

test("loadContextResources collects context files, skills, and prompt templates in source order", async () => {
  const resources = await loadContextResources({
    source: memorySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md", "/work/app/.pi/skills/private/SKILL.md"],
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  assert.deepEqual(resources.contextFiles.map((file) => file.path), [
    "/home/me/.pi/agent/AGENTS.md",
    "/work/AGENTS.md",
    "/work/app/CLAUDE.md",
  ]);
  assert.deepEqual(resources.skills.map((skill) => [skill.name, skill.description, skill.disableModelInvocation]), [
    ["review", "Review code changes.", false],
    ["private", "Hidden from the model.", true],
  ]);
  assert.deepEqual(resources.promptTemplates.map((template) => [template.name, template.description]), [
    ["fix", "Fix a target file."],
  ]);
});

test("buildContextSystemPrompt renders context files and only model-visible skills", async () => {
  const resources = await loadContextResources({
    source: memorySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md", "/work/app/.pi/skills/private/SKILL.md"],
  });

  const prompt = buildContextSystemPrompt({
    cwd: "/work/app",
    activeToolNames: ["read_file"],
    contextFiles: resources.contextFiles,
    skills: resources.skills,
  });
  assert.match(prompt, /Global instruction\./);
  assert.match(prompt, /Workspace instruction\./);
  assert.match(prompt, /App instruction\./);
  assert.match(prompt, /<name>review<\/name>/);
  assert.doesNotMatch(prompt, /<name>private<\/name>/);

  const noReadPrompt = buildContextSystemPrompt({
    cwd: "/work/app",
    activeToolNames: [],
    contextFiles: resources.contextFiles,
    skills: resources.skills,
  });
  assert.doesNotMatch(noReadPrompt, /<available_skills>/);
});

test("formatPromptTemplateInvocation expands once without recursively expanding argument values", async () => {
  const resources = await loadContextResources({
    source: memorySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  assert.equal(
    formatPromptTemplateInvocation(resources.promptTemplates[0]!, ["README.md", "edge cases"]),
    "Fix README.md with focus on README.md edge cases.",
  );
  assert.equal(
    formatPromptTemplateInvocation({
      name: "guard",
      description: "guard",
      filePath: "/work/app/guard.md",
      content: "Fix $1 then $ARGUMENTS.",
    }, ["$ARGUMENTS", "$2"]),
    "Fix $ARGUMENTS then $ARGUMENTS $2.",
  );
});

test("createContextResourceTurnState connects resources to the S06 AgentMessage turn snapshot", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const turnState = await createContextResourceTurnState({
    source: memorySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createMemorySession("s08", [{ role: "user", content: "Use project rules.", timestamp: 1 }]),
    model: faux.getModel(),
    registry: createRegistry(),
    activeToolNames: ["read_file"],
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md"],
    promptTemplateFiles: ["/work/app/.pi/prompts/fix.md"],
  });

  assert.equal(turnState.sessionId, "s08");
  assert.deepEqual(turnState.messages.map((message) => message.role), ["user"]);
  assert.deepEqual(turnState.resources.promptTemplates?.map((template) => template.name), ["fix"]);
  assert.deepEqual(turnState.contextFiles.map((file) => file.path), [
    "/home/me/.pi/agent/AGENTS.md",
    "/work/AGENTS.md",
    "/work/app/CLAUDE.md",
  ]);
  assert.match(turnState.systemPrompt, /Global instruction\./);
  assert.match(turnState.systemPrompt, /<name>review<\/name>/);
});

test("runContextResourceTurn keeps resources and the read_file tool in the live loop", async (t) => {
  let firstSystemPrompt = "";
  let firstTools: string[] = [];
  const faux = setupFauxProvider([
    (context) => {
      firstSystemPrompt = context.systemPrompt ?? "";
      firstTools = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage([
        fauxToolCall("read_file", { path: "README.md" }),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("Used the project rules and file contents.")]),
  ]);
  t.after(() => faux.unregister());
  const session = createMemorySession("s08-live");

  const result = await runContextResourceTurn({
    source: memorySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createRegistry(),
    activeToolNames: ["read_file"],
    skillFiles: ["/work/app/.pi/skills/review/SKILL.md"],
    prompt: "Read README.md under the project rules",
  });

  assert.match(firstSystemPrompt, /Global instruction\./);
  assert.match(firstSystemPrompt, /<name>review<\/name>/);
  assert.deepEqual(firstTools, ["read_file"]);
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(session.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(result.contextResources.skills[0]?.name, "review");
});
