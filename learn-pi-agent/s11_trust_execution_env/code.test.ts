import assert from "node:assert/strict";
import test from "node:test";

import {
  MiniTrustStore,
  createContainedExecutionEnv,
  createLocalExecutionEnv,
  hasProjectTrustInputs,
  loadProjectInputs,
  resolveProjectTrusted,
} from "./code.ts";

const files = {
  "/repo/AGENTS.md": "Project context.",
  "/repo/.pi/settings.json": "{\"model\":\"demo\"}",
  "/repo/.pi/extensions/guard.ts": "export default function guard() {}",
  "/repo/.pi/prompts/review.md": "Review this change.",
  "/repo/src/app.ts": "console.log('app')",
  "/repo/secret.txt": "token",
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

test("declining project trust skips gated project inputs but keeps context files", async () => {
  const trusted = await resolveProjectTrusted({
    files,
    cwd: "/repo",
    mode: "interactive",
    defaultProjectTrust: "ask",
    trustStore: new MiniTrustStore(),
    promptDecision: false,
  });

  const inputs = loadProjectInputs(files, "/repo", trusted);

  assert.equal(trusted, false);
  assert.deepEqual(inputs.contextFiles, ["/repo/AGENTS.md"]);
  assert.equal(inputs.projectSettingsLoaded, false);
  assert.deepEqual(inputs.extensionPaths, []);
  assert.deepEqual(inputs.promptPaths, []);
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
  const trusted = await resolveProjectTrusted({
    files,
    cwd: "/repo",
    mode: "print",
    defaultProjectTrust: "ask",
    trustStore: new MiniTrustStore(),
  });

  assert.equal(trusted, false);
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

test("project trust is not a sandbox for local read, write, and bash operations", async () => {
  const trusted = await resolveProjectTrusted({
    files,
    cwd: "/repo",
    mode: "interactive",
    defaultProjectTrust: "ask",
    trustStore: new MiniTrustStore(),
    promptDecision: false,
  });
  const env = createLocalExecutionEnv(files);

  assert.equal(trusted, false);
  assert.equal(await env.readFile("/repo/secret.txt"), "token");
  await env.writeFile("/repo/new.txt", "created locally");
  assert.equal(await env.readFile("/repo/new.txt"), "created locally");
  assert.equal(await env.runBash("npm test", "/repo"), "local:/repo$ npm test");
});

test("a contained execution env is a separate policy layer from project trust", async () => {
  const trusted = await resolveProjectTrusted({
    files,
    cwd: "/repo",
    mode: "interactive",
    defaultProjectTrust: "always",
    trustStore: new MiniTrustStore(),
  });
  const env = createContainedExecutionEnv(files, {
    root: "/repo",
    allowedBashPrefixes: ["npm ", "node "],
  });

  assert.equal(trusted, true);
  assert.equal(await env.readFile("/repo/src/app.ts"), "console.log('app')");
  await assert.rejects(() => env.readFile("/etc/passwd"), /outside contained root/);
  await assert.rejects(() => env.runBash("rm -rf /", "/repo"), /command blocked/);
});
