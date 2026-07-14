import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_LESSON_IDS = Array.from({ length: 13 }, (_, index) => index + 1);
const MISSING_KEY = /OPENAI_API_KEY[^\n]*(?:required|missing)|(?:required|missing)[^\n]*OPENAI_API_KEY/i;
const NETWORK_BLOCKED = "ENTRY_CHECK_NETWORK_BLOCKED";
const MAIN_HANDSHAKE_PREFIX = "PI_ENTRY_CHECK_MAIN:";
const MAINTENANCE_SCRIPTS = {
  test: "node --test shared/*.test.ts s*/code.test.ts",
  typecheck: "tsc --noEmit",
  "check:deps": "node scripts/check-deps.mjs",
  "check:entries": "node scripts/check-entries.mjs",
  check: "npm run typecheck && npm test && npm run check:deps && npm run check:entries",
};

export function runEntryChecks(courseRoot, options = {}) {
  const root = resolve(courseRoot);
  const issues = [];
  const entries = discoverExpectedEntries(root, issues);
  validatePackageWiring(root, entries, issues);
  const handshakeToken = options.handshakeToken ?? randomUUID();
  const preloadDirectory = mkdtempSync(join(tmpdir(), "pi-entry-preload-"));
  const preloadPath = join(preloadDirectory, "block-network.mjs");
  writeFileSync(preloadPath, networkBlockerSource());

  try {
    for (const entry of entries) {
      const result = (options.spawn ?? spawnSync)(
        options.nodePath ?? process.execPath,
        ["--import", pathToFileURL(preloadPath).href, entry.path],
        {
          cwd: root,
          env: controlledEnvironment(handshakeToken),
          encoding: "utf8",
          input: "",
          timeout: options.timeoutMs ?? 8_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const issue = classifyEntryResult(root, entry, result, handshakeToken);
      if (issue) issues.push(issue);
    }
  } finally {
    rmSync(preloadDirectory, { recursive: true, force: true });
  }

  return issues;
}

function discoverExpectedEntries(root, issues) {
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const entries = [];

  for (const id of EXPECTED_LESSON_IDS) {
    const prefix = `s${String(id).padStart(2, "0")}_`;
    const matches = directories.filter((name) => name.startsWith(prefix));
    if (matches.length !== 1) {
      issues.push({
        code: "entry-discovery",
        message: `${prefix} expected one lesson directory, found ${matches.length}: ${matches.join(", ") || "none"}`,
      });
      continue;
    }
    entries.push({ id, path: join(root, matches[0], "code.ts") });
  }
  return entries;
}

function validatePackageWiring(root, entries, issues) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    issues.push({
      code: "package-wiring",
      message: `package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const expectedScriptNames = [
    ...EXPECTED_LESSON_IDS.map((id) => `s${String(id).padStart(2, "0")}`),
    ...Object.keys(MAINTENANCE_SCRIPTS),
  ].sort();
  const actualScriptNames = Object.keys(packageJson.scripts ?? {}).sort();
  if (JSON.stringify(actualScriptNames) !== JSON.stringify(expectedScriptNames)) {
    issues.push({
      code: "package-wiring",
      message: `package scripts must be exactly ${expectedScriptNames.join(", ")}; found ${actualScriptNames.join(", ") || "none"}`,
    });
  }

  for (const entry of entries) {
    const scriptName = `s${String(entry.id).padStart(2, "0")}`;
    const expectedTarget = relative(root, entry.path).split(sep).join("/");
    const command = packageJson.scripts?.[scriptName];
    const expectedCommand = `node --env-file-if-exists=.env ${expectedTarget}`;
    if (command !== expectedCommand) {
      issues.push({
        code: "package-wiring",
        message: `package script ${scriptName} must be ${JSON.stringify(expectedCommand)}; found ${JSON.stringify(command)}`,
      });
    }
  }

  for (const [name, expectedCommand] of Object.entries(MAINTENANCE_SCRIPTS)) {
    const command = packageJson.scripts?.[name];
    if (command !== expectedCommand) {
      issues.push({
        code: "package-wiring",
        message: `package script ${name} must be ${JSON.stringify(expectedCommand)}; found ${JSON.stringify(command)}`,
      });
    }
  }
}

function controlledEnvironment(handshakeToken) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)$/i.test(name)) delete env[name];
  }
  return {
    ...env,
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENAI_API_KEY: "",
    OPENAI_MODEL: "gpt-4o-mini",
    OPENAI_BASE_URL: "http://127.0.0.1:9",
    PI_ENTRY_CHECK_TOKEN: handshakeToken,
  };
}

function classifyEntryResult(root, entry, result, handshakeToken) {
  const path = relative(root, entry.path).split(sep).join("/");
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const handshake = `${MAIN_HANDSHAKE_PREFIX}${handshakeToken}`;
  const hasHandshake = output.split(/\r?\n/).some((line) => line.trim() === handshake);

  if (result.error) {
    const timedOut = result.error && typeof result.error === "object" && "code" in result.error
      && result.error.code === "ETIMEDOUT";
    return {
      code: timedOut ? "entry-timeout" : "entry-spawn",
      message: `${path}: ${timedOut ? "entry did not terminate under missing-key startup" : result.error.message}`,
    };
  }
  if (output.includes(NETWORK_BLOCKED)) {
    return {
      code: "entry-network",
      message: `${path}: attempted network access before rejecting the missing API key`,
    };
  }
  if (result.signal) {
    return {
      code: "entry-signal",
      message: `${path}: terminated by ${result.signal}`,
    };
  }
  if (result.status === 0) {
    return {
      code: "entry-not-started",
      message: `${path}: entry exited successfully instead of starting the live missing-key path`,
    };
  }
  if (!hasHandshake) {
    return {
      code: MISSING_KEY.test(output) ? "entry-not-started" : "entry-startup",
      message: `${path}: main-path handshake was missing; got ${summarizeOutput(output)}`,
    };
  }
  if (!MISSING_KEY.test(output)) {
    return {
      code: "entry-startup",
      message: `${path}: expected a controlled OPENAI_API_KEY error, got ${summarizeOutput(output)}`,
    };
  }
  return undefined;
}

function summarizeOutput(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 3).join(" | ") || "no diagnostic output";
}

function networkBlockerSource() {
  return `
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const blocked = () => { throw new Error("${NETWORK_BLOCKED}"); };
globalThis.fetch = async () => blocked();
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
syncBuiltinESMExports();
`;
}

function parseRootArgument(argv, fallbackRoot) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return fallbackRoot;
  const root = argv[rootIndex + 1];
  if (!root) throw new Error("--root requires a directory path");
  return root;
}

function runSelfTest(reportSuccess = true) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-check-entries-"));
  try {
    const scripts = {};
    const liveEntry = `
console.error("PI_ENTRY_CHECK_MAIN:" + process.env.PI_ENTRY_CHECK_TOKEN);
throw new Error("OPENAI_API_KEY is required for live model calls");
`;
    for (const id of EXPECTED_LESSON_IDS) {
      const lessonId = `s${String(id).padStart(2, "0")}`;
      const directory = join(fixtureRoot, `${lessonId}_lesson`);
      mkdirSync(directory);
      writeFileSync(join(directory, "code.ts"), liveEntry);
      scripts[lessonId] = `node --env-file-if-exists=.env ${lessonId}_lesson/code.ts`;
    }
    Object.assign(scripts, MAINTENANCE_SCRIPTS);
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`);
    assert.deepEqual(runEntryChecks(fixtureRoot), []);

    writeFileSync(
      join(fixtureRoot, "s02_lesson", "code.ts"),
      'throw new Error("OPENAI_API_KEY is required for live model calls");\n',
    );
    const notStarted = runEntryChecks(fixtureRoot);
    assert.ok(notStarted.some((issue) => issue.code === "entry-not-started" && issue.message.includes("s02_lesson")));

    writeFileSync(join(fixtureRoot, "s02_lesson", "code.ts"), liveEntry);
    const packageJson = JSON.parse(String(readFileSync(join(fixtureRoot, "package.json"))));
    packageJson.scripts.s01 = "node --env-file-if-exists=.env s02_lesson/code.ts";
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    const wrongWiring = runEntryChecks(fixtureRoot);
    assert.ok(wrongWiring.some((issue) => issue.code === "package-wiring" && issue.message.includes("s01")));
    packageJson.scripts.s01 = "node --env-file-if-exists=.env s01_lesson/code.ts";
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

    packageJson.scripts["session:s01"] = "npm run s01";
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    const extraScript = runEntryChecks(fixtureRoot);
    assert.ok(extraScript.some((issue) => issue.code === "package-wiring" && issue.message.includes("scripts must be exactly")));
    delete packageJson.scripts["session:s01"];
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

    writeFileSync(join(fixtureRoot, "s02_lesson", "code.ts"), liveEntry);
    writeFileSync(
      join(fixtureRoot, "s03_lesson", "code.ts"),
      `${liveEntry.replace('throw new Error("OPENAI_API_KEY is required for live model calls");', 'await fetch("https://example.com");')}\n`,
    );
    writeFileSync(join(fixtureRoot, "s04_lesson", "code.ts"), "export const = ;\n");
    writeFileSync(join(fixtureRoot, "s05_lesson", "code.ts"), 'import "./missing.ts";\n');
    const startupFailures = runEntryChecks(fixtureRoot);
    assert.ok(startupFailures.some((issue) => issue.code === "entry-network" && issue.message.includes("s03_lesson")));
    assert.ok(startupFailures.some((issue) => issue.code === "entry-startup" && issue.message.includes("s04_lesson")));
    assert.ok(startupFailures.some((issue) => issue.code === "entry-startup" && issue.message.includes("s05_lesson")));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  if (reportSuccess) console.log("check-entries self-test passed");
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
  } else {
    runSelfTest(false);
    const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const root = parseRootArgument(process.argv.slice(2), defaultRoot);
    const issues = runEntryChecks(root);
    if (issues.length === 0) {
      console.log("Entry checks passed: s01-s13 reject missing credentials before any network call");
    } else {
      console.error(`Entry checks failed with ${issues.length} issue(s):`);
      for (const issue of issues) console.error(`- [${issue.code}] ${issue.message}`);
      process.exitCode = 1;
    }
  }
}
