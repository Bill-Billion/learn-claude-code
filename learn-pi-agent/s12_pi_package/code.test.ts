import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../s02_tool_schema/code.ts";
import { createMemorySession } from "../s06_turn_state/code.ts";
import { runPrintMode } from "../s10_runtime_modes/code.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";
import {
  createPackageRuntime,
  createPackageManifest,
  getEnabledPaths,
  type PackageFilter,
  resolvePiPackages,
  summarizeResolvedResources,
} from "./code.ts";

const files = {
  "/packages/review/package.json": JSON.stringify(
    createPackageManifest("review-pack", {
      extensions: ["extensions"],
      skills: ["skills"],
      prompts: ["prompts/review.md"],
      themes: ["themes"],
    }),
  ),
  "/packages/review/extensions/review.ts": "export default function review() {}",
  "/packages/review/extensions/legacy.ts": "export default function legacy() {}",
  "/packages/review/skills/review/SKILL.md": "# Review skill",
  "/packages/review/prompts/review.md": "Review this diff.",
  "/packages/review/prompts/draft.md": "Draft release notes.",
  "/packages/review/themes/review.json": "{}",
  "/packages/convention/extensions/notify.ts": "export default function notify() {}",
  "/packages/convention/skills/notes/SKILL.md": "# Notes",
  "/packages/convention/prompts/fix.md": "Fix this.",
  "/packages/convention/themes/focus.json": "{}",
  "/packages/empty/package.json": JSON.stringify({ name: "empty" }),
  "/repo/.pi/git/github.com/team/review/package.json": JSON.stringify(
    createPackageManifest("review-pack", {
      extensions: ["extensions"],
      prompts: ["prompts"],
    }),
  ),
  "/repo/.pi/git/github.com/team/review/extensions/project.ts": "export default function project() {}",
  "/repo/.pi/git/github.com/team/review/prompts/project.md": "Project prompt.",
};

const patternPackageFiles = {
  "/packages/patterns/package.json": JSON.stringify({ name: "patterns" }),
  "/packages/patterns/extensions/top.ts": "export default function top() {}",
  "/packages/patterns/extensions/nested/index.ts": "export default function nested() {}",
  "/packages/patterns/extensions/nested/helper.ts": "export const helper = true;",
  "/packages/patterns/skills/review/SKILL.md": "# Review skill",
  "/packages/patterns/skills/legacy/SKILL.md": "# Legacy skill",
};

function resolvePatternPackage(filter: PackageFilter) {
  return resolvePiPackages({
    files: patternPackageFiles,
    userPackages: [{ source: "/packages/patterns", ...filter }],
    projectPackages: [],
    projectTrusted: true,
  });
}

test("a pi manifest decides which package resources are exported", () => {
  const resolved = resolvePiPackages({
    files,
    userPackages: ["/packages/review"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/packages/review/extensions/legacy.ts",
    "/packages/review/extensions/review.ts",
  ]);
  assert.deepEqual(getEnabledPaths(resolved.skills), ["/packages/review/skills/review/SKILL.md"]);
  assert.deepEqual(getEnabledPaths(resolved.prompts), ["/packages/review/prompts/review.md"]);
  assert.deepEqual(getEnabledPaths(resolved.themes), ["/packages/review/themes/review.json"]);
});

test("an unfiltered pi manifest treats omitted resource keys as empty", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/partial/package.json": JSON.stringify(
        createPackageManifest("partial-pack", {
          extensions: ["extensions/main.ts"],
        }),
      ),
      "/packages/partial/extensions/main.ts": "export default function main() {}",
      "/packages/partial/skills/fallback/SKILL.md": "# Must stay hidden",
      "/packages/partial/prompts/fallback.md": "Must stay hidden.",
      "/packages/partial/themes/fallback.json": "{}",
    },
    userPackages: ["/packages/partial"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(summarizeResolvedResources(resolved), {
    extensions: ["/packages/partial/extensions/main.ts"],
    skills: [],
    prompts: [],
    themes: [],
  });
});

test("empty manifest arrays export no resources", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/manifest-empty/package.json": JSON.stringify(
        createPackageManifest("manifest-empty", {
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        }),
      ),
      "/packages/manifest-empty/extensions/fallback.ts": "export default function fallback() {}",
      "/packages/manifest-empty/skills/fallback/SKILL.md": "# Must stay hidden",
      "/packages/manifest-empty/prompts/fallback.md": "Must stay hidden.",
      "/packages/manifest-empty/themes/fallback.json": "{}",
    },
    userPackages: ["/packages/manifest-empty"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(summarizeResolvedResources(resolved), {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
});

test("a manifest exposes listed files but not neighboring package files", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/listed/package.json": JSON.stringify(
        createPackageManifest("listed-pack", {
          extensions: ["extensions/main.ts"],
          prompts: ["prompts/review.md"],
        }),
      ),
      "/packages/listed/extensions/main.ts": "export default function main() {}",
      "/packages/listed/extensions/helper.ts": "export const helper = true;",
      "/packages/listed/prompts/review.md": "Review this.",
      "/packages/listed/prompts/draft.md": "Draft this.",
    },
    userPackages: ["/packages/listed"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), ["/packages/listed/extensions/main.ts"]);
  assert.deepEqual(getEnabledPaths(resolved.prompts), ["/packages/listed/prompts/review.md"]);
});

test("packages without a pi manifest use conventional directories", () => {
  const resolved = resolvePiPackages({
    files,
    userPackages: ["/packages/convention"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(summarizeResolvedResources(resolved), {
    extensions: ["/packages/convention/extensions/notify.ts"],
    skills: ["/packages/convention/skills/notes/SKILL.md"],
    prompts: ["/packages/convention/prompts/fix.md"],
    themes: ["/packages/convention/themes/focus.json"],
  });
});

test("a package.json without pi still uses conventional directories", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/package-json-only/package.json": JSON.stringify({ name: "package-json-only" }),
      "/packages/package-json-only/extensions/main.ts": "export default function main() {}",
      "/packages/package-json-only/skills/main/SKILL.md": "# Main skill",
      "/packages/package-json-only/prompts/main.md": "Run main.",
      "/packages/package-json-only/themes/main.json": "{}",
    },
    userPackages: ["/packages/package-json-only"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(summarizeResolvedResources(resolved), {
    extensions: ["/packages/package-json-only/extensions/main.ts"],
    skills: ["/packages/package-json-only/skills/main/SKILL.md"],
    prompts: ["/packages/package-json-only/prompts/main.md"],
    themes: ["/packages/package-json-only/themes/main.json"],
  });
});

test("conventional extension discovery loads entrypoints but skips nested helpers", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/multi-file/package.json": JSON.stringify({ name: "multi-file" }),
      "/packages/multi-file/extensions/standalone.ts": "export default function standalone() {}",
      "/packages/multi-file/extensions/subagent/index.ts": "export default function subagent() {}",
      "/packages/multi-file/extensions/subagent/helper.ts": "export const helper = true;",
      "/packages/multi-file/extensions/custom/package.json": JSON.stringify({
        pi: { extensions: ["main.js"] },
      }),
      "/packages/multi-file/extensions/custom/main.js": "export default function custom() {}",
      "/packages/multi-file/extensions/custom/helper.js": "export const helper = true;",
      "/packages/multi-file/extensions/no-entry/helper.ts": "export const helper = true;",
    },
    userPackages: ["/packages/multi-file"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/packages/multi-file/extensions/custom/main.js",
    "/packages/multi-file/extensions/standalone.ts",
    "/packages/multi-file/extensions/subagent/index.ts",
  ]);
});

test("a manifest extension glob resolves matched child directories as entrypoints", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/manifest-glob/package.json": JSON.stringify(
        createPackageManifest("manifest-glob", {
          extensions: ["extensions/*"],
        }),
      ),
      "/packages/manifest-glob/extensions/standalone.ts": "export default function standalone() {}",
      "/packages/manifest-glob/extensions/subagent/index.ts": "export default function subagent() {}",
      "/packages/manifest-glob/extensions/subagent/helper.ts": "export const helper = true;",
    },
    userPackages: ["/packages/manifest-glob"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/packages/manifest-glob/extensions/standalone.ts",
    "/packages/manifest-glob/extensions/subagent/index.ts",
  ]);
});

test("settings filters narrow resources and empty arrays disable a resource type", () => {
  const resolved = resolvePiPackages({
    files,
    userPackages: [
      {
        source: "/packages/review",
        extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
        prompts: [],
        themes: ["+themes/review.json"],
      },
    ],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), ["/packages/review/extensions/review.ts"]);
  assert.deepEqual(resolved.prompts.map((entry) => ({ path: entry.path, enabled: entry.enabled })), [
    { path: "/packages/review/prompts/review.md", enabled: false },
  ]);
  assert.deepEqual(getEnabledPaths(resolved.themes), ["/packages/review/themes/review.json"]);
});

test("installer filters match extension basenames", () => {
  const resolved = resolvePatternPackage({ extensions: ["*.ts"] });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/packages/patterns/extensions/nested/index.ts",
    "/packages/patterns/extensions/top.ts",
  ]);
});

test("installer filter globstars match zero or more directories", () => {
  const resolved = resolvePatternPackage({ extensions: ["extensions/**/*.ts"] });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/packages/patterns/extensions/nested/index.ts",
    "/packages/patterns/extensions/top.ts",
  ]);
});

test("installer filters match absolute resource paths", () => {
  const resolved = resolvePatternPackage({
    extensions: ["/packages/patterns/extensions/*.ts"],
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), ["/packages/patterns/extensions/top.ts"]);
});

test("plain installer patterns do not recursively select a directory", () => {
  const resolved = resolvePatternPackage({ extensions: ["extensions"] });

  assert.deepEqual(getEnabledPaths(resolved.extensions), []);
});

test("installer filters match skill parent names and relative directories", () => {
  const byName = resolvePatternPackage({ skills: ["review"] });
  const byRelativeDirectory = resolvePatternPackage({ skills: ["skills/re*"] });

  const expected = ["/packages/patterns/skills/review/SKILL.md"];
  assert.deepEqual(getEnabledPaths(byName.skills), expected);
  assert.deepEqual(getEnabledPaths(byRelativeDirectory.skills), expected);
});

test("exact installer overrides recognize skill directory identities", () => {
  const forceIncluded = resolvePatternPackage({
    skills: ["!SKILL.md", "+skills/review"],
  });
  const forceExcluded = resolvePatternPackage({
    skills: ["-/packages/patterns/skills/legacy"],
  });

  const expected = ["/packages/patterns/skills/review/SKILL.md"];
  assert.deepEqual(getEnabledPaths(forceIncluded.skills), expected);
  assert.deepEqual(getEnabledPaths(forceExcluded.skills), expected);
});

test("an object-form package uses conventions for omitted manifest resource keys", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/filtered-default/package.json": JSON.stringify(
        createPackageManifest("filtered-default", {
          extensions: ["extensions/main.ts"],
          prompts: [],
        }),
      ),
      "/packages/filtered-default/extensions/main.ts": "export default function main() {}",
      "/packages/filtered-default/skills/default/SKILL.md": "# Default skill",
      "/packages/filtered-default/prompts/default.md": "Must stay hidden.",
    },
    userPackages: [{ source: "/packages/filtered-default" }],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), ["/packages/filtered-default/extensions/main.ts"]);
  assert.deepEqual(getEnabledPaths(resolved.skills), ["/packages/filtered-default/skills/default/SKILL.md"]);
  assert.deepEqual(getEnabledPaths(resolved.prompts), []);
});

test("installer filters use conventions for empty manifest arrays without widening non-empty arrays", () => {
  const resolved = resolvePiPackages({
    files: {
      "/packages/filtered/package.json": JSON.stringify(
        createPackageManifest("filtered", {
          extensions: ["extensions/main.ts"],
          prompts: [],
        }),
      ),
      "/packages/filtered/extensions/main.ts": "export default function main() {}",
      "/packages/filtered/extensions/helper.ts": "export const helper = true;",
      "/packages/filtered/prompts/review.md": "Review this.",
    },
    userPackages: [
      {
        source: "/packages/filtered",
        extensions: ["extensions/*.ts"],
        prompts: ["prompts/*.md"],
      },
    ],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), ["/packages/filtered/extensions/main.ts"]);
  assert.deepEqual(getEnabledPaths(resolved.prompts), ["/packages/filtered/prompts/review.md"]);
});

test("project packages are skipped until the project is trusted", () => {
  const unresolved = resolvePiPackages({
    files,
    userPackages: ["/packages/convention"],
    projectPackages: ["git:github.com/team/review"],
    cwd: "/repo",
    projectTrusted: false,
  });
  const trusted = resolvePiPackages({
    files,
    userPackages: ["/packages/convention"],
    projectPackages: ["git:github.com/team/review"],
    cwd: "/repo",
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(unresolved.extensions), ["/packages/convention/extensions/notify.ts"]);
  assert.deepEqual(getEnabledPaths(trusted.extensions), [
    "/repo/.pi/git/github.com/team/review/extensions/project.ts",
    "/packages/convention/extensions/notify.ts",
  ]);
});

test("a project package wins over the same package configured globally", () => {
  const resolved = resolvePiPackages({
    files,
    userPackages: ["git:github.com/team/review"],
    projectPackages: ["git:github.com/team/review"],
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/repo/.pi/git/github.com/team/review/extensions/project.ts",
  ]);
  assert.equal(resolved.extensions[0]?.metadata.scope, "project");
});

test("protocol git URLs resolve to the same installed package root", () => {
  const resolved = resolvePiPackages({
    files,
    userPackages: ["https://github.com/team/review"],
    projectPackages: [],
    agentDir: "/repo/.pi",
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), [
    "/repo/.pi/git/github.com/team/review/extensions/project.ts",
  ]);
});

test("a local file package loads as a single extension", () => {
  const resolved = resolvePiPackages({
    files: {
      ...files,
      "/tmp/one-file.ts": "export default function oneFile() {}",
    },
    userPackages: ["/tmp/one-file.ts"],
    projectPackages: [],
    projectTrusted: true,
  });

  assert.deepEqual(getEnabledPaths(resolved.extensions), ["/tmp/one-file.ts"]);
  assert.deepEqual(getEnabledPaths(resolved.skills), []);
});

test("resolved package extensions, skills, and prompts configure the real runtime", async (t) => {
  const runtimeFiles = {
    "/repo/AGENTS.md": "Project baseline.",
    "/packages/runtime/package.json": JSON.stringify(
      createPackageManifest("runtime-pack", {
        extensions: ["extensions/runtime.ts"],
        skills: ["skills/review/SKILL.md"],
        prompts: ["prompts/review.md"],
      }),
    ),
    "/packages/runtime/extensions/runtime.ts": "export default runtimeExtension",
    "/packages/runtime/skills/review/SKILL.md": [
      "---",
      "name: package-review",
      "description: Review with the package checklist.",
      "---",
      "Inspect the complete diff.",
    ].join("\n"),
    "/packages/runtime/prompts/review.md": "---\ndescription: Review a change.\n---\nReview $ARGUMENTS.",
  };
  let normalSystemPrompt = "";
  let invocationSystemPrompt = "";
  let invokedUserPrompt = "";
  let providerTools: string[] = [];
  let packageToolExecutions = 0;
  const faux = setupFauxProvider([
    (context) => {
      normalSystemPrompt = context.systemPrompt ?? "";
      providerTools = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage([fauxToolCall("package_review", { target: "change" })], {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage([fauxText("Package resources reached the model.")]),
    (context) => {
      invocationSystemPrompt = context.systemPrompt ?? "";
      const message = context.messages.at(-1);
      invokedUserPrompt = message?.role === "user" && typeof message.content === "string"
        ? message.content
        : "";
      return fauxAssistantMessage([fauxText("Prompt template invoked.")]);
    },
  ]);
  t.after(() => faux.unregister());

  const prepared = await createPackageRuntime({
    files: runtimeFiles,
    userPackages: ["/packages/runtime"],
    projectPackages: [],
    projectTrusted: true,
    extensionSources: [{
      path: "/packages/runtime/extensions/runtime.ts",
      factory(pi) {
        pi.registerTool({
          name: "package_review",
          description: "Review a target with the package.",
          parameters: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
          },
          handler(input) {
            packageToolExecutions += 1;
            return { toolName: "package_review", content: `reviewed:${String(input.target)}` };
          },
        });
      },
    }],
    runtimeOptions: {
      source: { readText: (path) => runtimeFiles[path as keyof typeof runtimeFiles] },
      cwd: "/repo",
      agentDir: "/home/me/.pi/agent",
      session: createMemorySession("s12-packages"),
      model: faux.getModel(),
      registry: createToolRegistry([{
        name: "read_file",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        handler(input) {
          return { toolName: "read_file", content: `contents:${String(input.path)}` };
        },
      }]),
    },
  });

  assert.deepEqual(prepared.selection, {
    extensionPaths: ["/packages/runtime/extensions/runtime.ts"],
    skillPaths: ["/packages/runtime/skills/review/SKILL.md"],
    promptPaths: ["/packages/runtime/prompts/review.md"],
    themePaths: [],
  });
  assert.equal(await runPrintMode(prepared.runtime, "Review this"), "Package resources reached the model.");
  assert.match(normalSystemPrompt, /<name>package-review<\/name>/);
  assert.doesNotMatch(normalSystemPrompt, /Review \$ARGUMENTS\./);
  assert.deepEqual(providerTools, ["read_file", "package_review"]);
  assert.equal(packageToolExecutions, 1);

  const invocation = await prepared.invokePromptTemplate("review", ["change"]);
  assert.equal(invocation.finalText, "Prompt template invoked.");
  assert.equal(invokedUserPrompt, "Review change.");
  assert.doesNotMatch(invocationSystemPrompt, /Review \$ARGUMENTS\./);
  assert.deepEqual(prepared.promptTemplates.map((template) => template.name), ["review"]);
});

test("a package may explicitly export nothing while the real model and tool loop keep working", async (t) => {
  const runtimeFiles = {
    "/packages/empty/package.json": JSON.stringify(
      createPackageManifest("empty-pack", {
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      }),
    ),
    "/packages/empty/extensions/hidden.ts": "export default hidden",
  };
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxToolCall("read_file", { path: "README.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The empty package did not replace the agent loop.")]),
  ]);
  t.after(() => faux.unregister());
  let reads = 0;

  const prepared = await createPackageRuntime({
    files: runtimeFiles,
    userPackages: ["/packages/empty"],
    projectPackages: [],
    projectTrusted: true,
    extensionSources: [],
    runtimeOptions: {
      source: { readText: () => undefined },
      cwd: "/repo",
      agentDir: "/home/me/.pi/agent",
      session: createMemorySession("s12-empty-package"),
      model: faux.getModel(),
      registry: createToolRegistry([{
        name: "read_file",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        handler(input) {
          reads += 1;
          return { toolName: "read_file", content: `contents:${String(input.path)}` };
        },
      }]),
      activeToolNames: ["read_file"],
    },
  });

  assert.deepEqual(prepared.selection, {
    extensionPaths: [],
    skillPaths: [],
    promptPaths: [],
    themePaths: [],
  });
  assert.equal(
    await runPrintMode(prepared.runtime, "Read the file"),
    "The empty package did not replace the agent loop.",
  );
  assert.equal(reads, 1);
});
