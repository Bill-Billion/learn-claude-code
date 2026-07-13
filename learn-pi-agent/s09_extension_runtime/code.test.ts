import assert from "node:assert/strict";
import test from "node:test";

import { createDemoToolRegistry, dispatchTool } from "../s02_tool_schema/code.ts";
import { createDemoSession, type MiniModel } from "../s06_turn_state/code.ts";
import {
  createExtensionTurnState,
  loadMiniExtensions,
  mergeExtensionTools,
  type MiniExtensionFactory,
} from "./code.ts";

const model: MiniModel = {
  provider: "demo",
  id: "demo-model",
};

test("extension factories register tools and commands while loading", async () => {
  const extension: MiniExtensionFactory = (pi) => {
    pi.registerTool({
      name: "echo",
      label: "echo",
      description: "Echo text from an extension.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      handler(input) {
        return { toolName: "echo", content: `echo: ${String(input.text)}` };
      },
    });

    pi.registerCommand("hello", {
      description: "Say hello.",
      async handler(args, ctx) {
        ctx.ui.notify(`hello ${args || "world"}`);
      },
    });
  };

  const runner = await loadMiniExtensions([{ path: "hello-extension.ts", factory: extension }]);
  const registry = mergeExtensionTools(createDemoToolRegistry(), runner);

  assert.deepEqual(runner.getTools().map((tool) => tool.name), ["echo"]);
  assert.equal((await dispatchTool(registry, "echo", { text: "Pi" })).content, "echo: Pi");

  const commandResult = await runner.runCommand("hello", "Pi");

  assert.deepEqual(commandResult.notifications, ["hello Pi"]);
});

test("before_agent_start handlers are chained in extension load order", async () => {
  const runner = await loadMiniExtensions([
    {
      path: "first.ts",
      factory(pi) {
        pi.on("before_agent_start", (event) => {
          return {
            systemPrompt: `${event.systemPrompt}\n[first]`,
            message: {
              customType: "first",
              content: "first extension saw the prompt",
              display: true,
            },
          };
        });
      },
    },
    {
      path: "second.ts",
      factory(pi) {
        pi.on("before_agent_start", (_event, ctx) => {
          return {
            systemPrompt: `${ctx.getSystemPrompt()}\n[second]`,
          };
        });
      },
    },
  ]);

  const result = await runner.emitBeforeAgentStart({
    prompt: "fix",
    systemPrompt: "base",
    systemPromptOptions: { cwd: "/work/app" },
  });

  assert.equal(result.systemPrompt, "base\n[first]\n[second]");
  assert.deepEqual(result.messages, [
    {
      customType: "first",
      content: "first extension saw the prompt",
      display: true,
    },
  ]);
});

test("resources_discover returns paths with extension provenance", async () => {
  const runner = await loadMiniExtensions([
    {
      path: "dynamic-resources.ts",
      factory(pi) {
        pi.on("resources_discover", (event) => {
          return {
            skillPaths: [`${event.cwd}/.pi/skills/review/SKILL.md`],
            promptPaths: [`${event.cwd}/.pi/prompts/fix.md`],
          };
        });
      },
    },
  ]);

  const result = await runner.emitResourcesDiscover("/work/app", "startup");

  assert.deepEqual(result.skillPaths, [
    { path: "/work/app/.pi/skills/review/SKILL.md", extensionPath: "dynamic-resources.ts" },
  ]);
  assert.deepEqual(result.promptPaths, [
    { path: "/work/app/.pi/prompts/fix.md", extensionPath: "dynamic-resources.ts" },
  ]);
});

test("tool_call handlers can block before the local tool runs", async () => {
  const runner = await loadMiniExtensions([
    {
      path: "guard.ts",
      factory(pi) {
        pi.on("tool_call", (event) => {
          if (event.toolName === "bash" && String(event.input.command).includes("rm -rf")) {
            return { block: true, reason: "Dangerous shell command" };
          }
        });
      },
    },
  ]);

  assert.deepEqual(await runner.emitToolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }), {
    block: true,
    reason: "Dangerous shell command",
  });
  assert.equal(await runner.emitToolCall({ toolName: "bash", input: { command: "ls" } }), undefined);
});

test("createExtensionTurnState connects extension tools and prompt hooks to s08 resources", async () => {
  const runner = await loadMiniExtensions([
    {
      path: "context-note.ts",
      factory(pi) {
        pi.registerTool({
          name: "note",
          label: "note",
          description: "Write a short note.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
          handler(input) {
            return { toolName: "note", content: `note: ${String(input.text)}` };
          },
        });

        pi.on("before_agent_start", (event) => {
          return { systemPrompt: `${event.systemPrompt}\nExtension note: keep the answer short.` };
        });
      },
    },
  ]);

  const turnState = await createExtensionTurnState({
    runner,
    files: {
      "/work/app/AGENTS.md": "Project rule.",
    },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createDemoSession("s09", [{ role: "user", content: "Use extensions." }]),
    model,
    registry: createDemoToolRegistry(),
  });

  assert.deepEqual(turnState.activeTools.map((tool) => tool.name), ["read", "bash", "note"]);
  assert.match(turnState.systemPrompt, /Project rule\./);
  assert.match(turnState.systemPrompt, /Extension note: keep the answer short\./);
});
