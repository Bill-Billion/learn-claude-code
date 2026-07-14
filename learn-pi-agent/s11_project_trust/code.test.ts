import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../s02_tool_schema/code.ts";
import { createMemorySession } from "../s06_turn_state/code.ts";
import { loadMiniExtensions } from "../s09_extension_runtime/code.ts";
import { runPrintMode } from "../s10_runtime_modes/code.ts";
import { fauxAssistantMessage, fauxText, setupFauxProvider } from "../test-support/faux-provider.ts";
import {
  MiniTrustStore,
  createProjectTrustRuntime,
  hasProjectTrustInputs,
  loadProjectInputs,
  parseDefaultProjectTrust,
  prepareProjectTrust,
  resolveProjectTrusted,
} from "./code.ts";

const files = {
  "/repo/AGENTS.md": "Project context.",
  "/repo/CLAUDE.md": "Additional context.",
  "/repo/.agents/skills/review/SKILL.md": "---\nname: review\ndescription: Review changes.\n---\nReview carefully.",
  "/repo/.pi/settings.json": "{\"model\":\"course\"}",
  "/repo/.pi/extensions/guard.ts": "export default function guard() {}",
  "/repo/.pi/prompts/review.md": "Review this change.",
  "/repo/.pi/packages/local/package.json": "{\"name\":\"local\"}",
  "/repo/src/app.ts": "console.log('app')",
};

const source = {
  readText(path: string) {
    return files[path as keyof typeof files];
  },
};

test("project trust inputs are detected from .pi or ancestor .agents/skills", () => {
  assert.equal(hasProjectTrustInputs(files, "/repo"), true);
  assert.equal(
    hasProjectTrustInputs(
      {
        "/workspace/.agents/skills/review/SKILL.md": "review skill",
        "/workspace/project/src/index.ts": "",
      },
      "/workspace/project",
    ),
    true,
  );
  assert.equal(hasProjectTrustInputs({ "/plain/AGENTS.md": "context only" }, "/plain"), false);
});

test("PI_PROJECT_TRUST parsing keeps ask as the safe default", () => {
  assert.equal(parseDefaultProjectTrust("always"), "always");
  assert.equal(parseDefaultProjectTrust("never"), "never");
  assert.equal(parseDefaultProjectTrust("ask"), "ask");
  assert.equal(parseDefaultProjectTrust(undefined), "ask");
  assert.equal(parseDefaultProjectTrust("unexpected"), "ask");
});

test("declining project trust keeps context files but rejects every executable project input", async () => {
  const prepared = await prepareProjectTrust({
    files,
    cwd: "/repo",
    mode: "interactive",
    defaultProjectTrust: "ask",
    trustStore: new MiniTrustStore(),
    promptDecision: false,
  });

  assert.equal(prepared.projectTrusted, false);
  assert.deepEqual(prepared.projectInputs.contextFiles, ["/repo/AGENTS.md"]);
  assert.equal(prepared.projectInputs.projectSettingsLoaded, false);
  assert.deepEqual(prepared.projectInputs.skillPaths, []);
  assert.deepEqual(prepared.projectInputs.extensionPaths, []);
  assert.deepEqual(prepared.projectInputs.promptPaths, []);
  assert.deepEqual(prepared.projectInputs.packagePaths, []);
});

test("trust enables project skills, settings, extensions, prompts, and packages", () => {
  assert.deepEqual(loadProjectInputs(files, "/repo", true), {
    contextFiles: ["/repo/AGENTS.md"],
    projectSettingsLoaded: true,
    skillPaths: ["/repo/.agents/skills/review/SKILL.md"],
    extensionPaths: ["/repo/.pi/extensions/guard.ts"],
    promptPaths: ["/repo/.pi/prompts/review.md"],
    packagePaths: ["/repo/.pi/packages/local/package.json"],
  });
});

test("context discovery uses S08 candidate precedence once per ancestor directory", () => {
  const inputs = loadProjectInputs({
    "/workspace/CLAUDE.MD": "workspace fallback",
    "/workspace/project/AGENTS.MD": "first candidate",
    "/workspace/project/CLAUDE.md": "must not also load",
  }, "/workspace/project", false);

  assert.deepEqual(inputs.contextFiles, [
    "/workspace/CLAUDE.MD",
    "/workspace/project/AGENTS.MD",
  ]);
});

test("trust override and saved parent decisions win before default policy", async () => {
  const store = new MiniTrustStore({ "/repo": true });
  const appFiles = {
    ...files,
    "/repo/app/.pi/settings.json": "{}",
  };

  assert.equal(
    await resolveProjectTrusted({
      files: appFiles,
      cwd: "/repo/app",
      mode: "json",
      defaultProjectTrust: "never",
      trustStore: store,
    }),
    true,
  );

  assert.equal(
    await resolveProjectTrusted({
      files,
      cwd: "/repo",
      mode: "rpc",
      defaultProjectTrust: "always",
      trustStore: store,
      trustOverride: false,
    }),
    false,
  );
});

test("non-interactive ask cannot prompt, so trust-gated inputs stay off", async () => {
  assert.equal(
    await resolveProjectTrusted({
      files,
      cwd: "/repo",
      mode: "print",
      defaultProjectTrust: "ask",
      trustStore: new MiniTrustStore(),
    }),
    false,
  );
});

test("project_trust extension decisions can own and remember the decision", async () => {
  const store = new MiniTrustStore();
  const trusted = await resolveProjectTrusted({
    files,
    cwd: "/repo",
    mode: "interactive",
    defaultProjectTrust: "ask",
    trustStore: store,
    extensionDecision: { trusted: "yes", remember: true },
  });

  assert.equal(trusted, true);
  assert.equal(store.get("/repo"), true);
});

test("project trust configures the real cumulative runtime instead of replacing it", async (t) => {
  let systemPrompt = "";
  const faux = setupFauxProvider([
    (context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage([fauxText("Real model completed the turn.")]);
    },
  ]);
  t.after(() => faux.unregister());

  const prepared = await createProjectTrustRuntime({
    files,
    cwd: "/repo",
    mode: "print",
    defaultProjectTrust: "never",
    trustStore: new MiniTrustStore(),
    runtimeOptions: {
      runner: await loadMiniExtensions([]),
      source,
      cwd: "/repo",
      agentDir: "/home/me/.pi/agent",
      session: createMemorySession("s11-project-trust"),
      model: faux.getModel(),
      registry: createToolRegistry([]),
    },
  });

  assert.equal(prepared.projectTrusted, false);
  assert.equal(await runPrintMode(prepared.runtime, "Use the real runtime"), "Real model completed the turn.");
  assert.match(systemPrompt, /Project context\./);
  assert.doesNotMatch(systemPrompt, /Additional context\./);
  assert.doesNotMatch(systemPrompt, /<name>review<\/name>/);
  assert.equal(prepared.runtime.getState().turns, 1);
});
