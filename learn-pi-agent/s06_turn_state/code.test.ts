import assert from "node:assert/strict";
import test from "node:test";

import { createDemoToolRegistry } from "../s02_tool_schema/code.ts";
import {
  createDemoSession,
  createMiniHarness,
  listActiveToolNames,
  type MiniModel,
} from "./code.ts";

const model: MiniModel = {
  provider: "demo",
  id: "demo-model",
};

test("createTurnState snapshots session messages and session id", async () => {
  const session = createDemoSession("session-1", [{ role: "user", content: "hello" }]);
  const harness = createMiniHarness({
    session,
    model,
    registry: createDemoToolRegistry(),
    systemPrompt: "You are Pi.",
  });

  const turnState = await harness.createTurnState();
  session.messages.push({ role: "user", content: "late edit" });

  assert.equal(turnState.sessionId, "session-1");
  assert.deepEqual(turnState.messages, [{ role: "user", content: "hello" }]);
});

test("createTurnState selects active tools and passes them to dynamic systemPrompt", async () => {
  const harness = createMiniHarness({
    session: createDemoSession("session-2"),
    model,
    registry: createDemoToolRegistry(),
    activeToolNames: ["read"],
    resources: {
      skills: [{ name: "audit", description: "Review tool output." }],
    },
    systemPrompt({ activeTools, resources }) {
      return `tools=${listActiveToolNames(activeTools)} skills=${resources.skills?.map((skill) => skill.name).join(",")}`;
    },
  });

  const turnState = await harness.createTurnState();

  assert.deepEqual(turnState.tools.map((tool) => tool.name), ["read", "bash"]);
  assert.deepEqual(turnState.activeTools.map((tool) => tool.name), ["read"]);
  assert.equal(turnState.systemPrompt, "tools=read skills=audit");
});

test("createTurnState clones resources and stream options for this turn", async () => {
  const resources = {
    promptTemplates: [{ name: "fix", content: "Fix {target}" }],
  };
  const streamOptions = {
    timeoutMs: 30,
    headers: { "x-demo": "one" },
    metadata: { turn: "first" },
  };
  const harness = createMiniHarness({
    session: createDemoSession("session-3"),
    model,
    registry: createDemoToolRegistry(),
    resources,
    streamOptions,
  });

  const turnState = await harness.createTurnState();
  resources.promptTemplates.push({ name: "late", content: "late" });
  streamOptions.headers["x-demo"] = "two";
  streamOptions.metadata.turn = "second";

  assert.deepEqual(turnState.resources.promptTemplates?.map((template) => template.name), ["fix"]);
  assert.deepEqual(turnState.streamOptions, {
    timeoutMs: 30,
    headers: { "x-demo": "one" },
    metadata: { turn: "first" },
  });
});

test("createTurnState rejects unknown active tools", () => {
  assert.throws(
    () => createMiniHarness({
      session: createDemoSession("session-4"),
      model,
      registry: createDemoToolRegistry(),
      activeToolNames: ["missing"],
    }),
    /Unknown active tool: missing/,
  );
});
