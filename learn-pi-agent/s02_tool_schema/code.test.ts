import assert from "node:assert/strict";
import test from "node:test";

import {
  createDemoToolRegistry,
  dispatchTool,
  listToolDefinitions,
} from "./code.ts";

test("listToolDefinitions exposes tool schemas without handlers", () => {
  const registry = createDemoToolRegistry();
  const definitions = listToolDefinitions(registry);

  assert.deepEqual(definitions.map((tool) => tool.name), ["read", "bash"]);
  assert.equal(definitions[0]?.parameters.required?.[0], "path");
  assert.equal("handler" in definitions[0]!, false);
});

test("dispatchTool finds handler by name and passes input", async () => {
  const registry = createDemoToolRegistry();

  const result = await dispatchTool(registry, "read", { path: "README.md" });

  assert.equal(result.toolName, "read");
  assert.equal(result.content, "read: README.md");
});

test("dispatchTool rejects unknown tools and invalid input", async () => {
  const registry = createDemoToolRegistry();

  await assert.rejects(
    () => dispatchTool(registry, "missing", {}),
    /Unknown tool: missing/,
  );
  await assert.rejects(
    () => dispatchTool(registry, "read", {}),
    /Missing required parameter: path/,
  );
  await assert.rejects(
    () => dispatchTool(registry, "read", { path: 42 }),
    /Invalid parameter type: path must be string/,
  );
});
