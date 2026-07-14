import assert from "node:assert/strict";
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
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const EXPECTED_LESSON_IDS = Array.from({ length: 13 }, (_, index) => index + 1);
const LESSON_DIRECTORY = /^s(\d{2})_/;
const EXPECTED_DEPENDENCIES = { "@earendil-works/pi-ai": "0.79.1" };
const EXPECTED_DEV_DEPENDENCIES = { "@types/node": "22.20.1", typescript: "5.9.3" };
const FORBIDDEN_MARKERS = [
  { name: "faux API", expression: /\bfaux[A-Za-z0-9_]*/gi },
  { name: "runDemo", expression: /\brunDemo\b/g },
  { name: "createDemo helper", expression: /\bcreateDemo[A-Za-z0-9_]*\b/g },
  { name: "demo CLI flag", expression: /--(?:s\d+-)?demo\b/g },
  { name: "test-support import", expression: /(?:^|["'/])test-support(?:["'/]|$)/gm },
  { name: "legacy compatibility API", expression: /\b(?:Legacy[A-Za-z0-9_]*|MiniMessage|MiniModel|SessionMessage|EventProvider|createTextProvider|createToolCallProvider)\b/g },
  { name: "offline production path", expression: /\boffline\b/gi },
];

export function runDependencyChecks(courseRoot) {
  const root = resolve(courseRoot);
  const lessons = discoverLessonDirectories(root);
  const issues = [];
  const actualIds = lessons.map((lesson) => lesson.id);

  validatePackageDependencies(root, issues);

  if (
    lessons.length !== EXPECTED_LESSON_IDS.length
    || EXPECTED_LESSON_IDS.some((id) => !actualIds.includes(id))
  ) {
    issues.push({
      code: "lesson-count",
      message: `expected exactly s01-s13 (13 lessons), found ${lessons.length}: ${lessons.map((lesson) => lesson.name).join(", ") || "none"}`,
    });
  }

  const productionFiles = [
    ...lessons.flatMap((lesson) => listTypeScriptFiles(join(root, lesson.name))),
    ...listTypeScriptFiles(join(root, "shared")),
  ].filter((path) => !path.endsWith(".test.ts"));

  for (const filePath of productionFiles) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch (error) {
      issues.push({
        code: "missing-production-file",
        message: `${displayPath(root, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const sourceLesson = lessonIdFromPath(root, filePath);
    for (const specifier of collectModuleSpecifiers(filePath, source)) {
      if (!sourceLesson || !specifier.startsWith(".")) continue;
      const targetPath = resolve(dirname(filePath), specifier);
      const targetLesson = lessonIdFromPath(root, targetPath);
      if (targetLesson && targetLesson > sourceLesson) {
        issues.push({
          code: "forward-import",
          message: `${displayPath(root, filePath)} imports later lesson s${String(targetLesson).padStart(2, "0")}: ${specifier}`,
        });
      }
    }

    for (const marker of FORBIDDEN_MARKERS) {
      marker.expression.lastIndex = 0;
      const match = marker.expression.exec(source);
      if (!match) continue;
      issues.push({
        code: "legacy-production-marker",
        message: `${displayPath(root, filePath)}:${lineNumberAt(source, match.index)} contains ${marker.name}: ${match[0]}`,
      });
    }
  }

  return issues;
}

function validatePackageDependencies(root, issues) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    issues.push({
      code: "package-dependencies",
      message: `package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  if (!sameStringRecord(packageJson.dependencies, EXPECTED_DEPENDENCIES)) {
    issues.push({
      code: "package-dependencies",
      message: `dependencies must be exactly ${JSON.stringify(EXPECTED_DEPENDENCIES)}; found ${JSON.stringify(packageJson.dependencies ?? {})}`,
    });
  }
  if (!sameStringRecord(packageJson.devDependencies, EXPECTED_DEV_DEPENDENCIES)) {
    issues.push({
      code: "package-dependencies",
      message: `devDependencies must be exactly ${JSON.stringify(EXPECTED_DEV_DEPENDENCIES)}; found ${JSON.stringify(packageJson.devDependencies ?? {})}`,
    });
  }
}

function sameStringRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function discoverLessonDirectories(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, match: LESSON_DIRECTORY.exec(entry.name) }))
    .filter(({ match }) => match !== null)
    .map(({ entry, match }) => ({ name: entry.name, id: Number(match[1]) }))
    .sort((left, right) => left.id - right.id || left.name.localeCompare(right.name));
}

function listTypeScriptFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function collectModuleSpecifiers(filePath, source) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function lessonIdFromPath(root, filePath) {
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || relativePath === "") return undefined;
  const firstSegment = relativePath.split(sep)[0];
  const match = LESSON_DIRECTORY.exec(firstSegment);
  return match ? Number(match[1]) : undefined;
}

function displayPath(root, filePath) {
  return relative(root, filePath).split(sep).join("/");
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function parseRootArgument(argv, fallbackRoot) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return fallbackRoot;
  const root = argv[rootIndex + 1];
  if (!root) throw new Error("--root requires a directory path");
  return root;
}

function runSelfTest(reportSuccess = true) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-check-deps-"));
  try {
    mkdirSync(join(fixtureRoot, "shared"));
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify({
      dependencies: EXPECTED_DEPENDENCIES,
      devDependencies: EXPECTED_DEV_DEPENDENCIES,
    }, null, 2)}\n`);
    writeFileSync(join(fixtureRoot, "shared", "model.ts"), "export const model = 'live';\n");
    for (const id of EXPECTED_LESSON_IDS) {
      const name = `s${String(id).padStart(2, "0")}_lesson`;
      mkdirSync(join(fixtureRoot, name));
      writeFileSync(join(fixtureRoot, name, "code.ts"), "export const lesson = true;\n");
    }
    assert.deepEqual(runDependencyChecks(fixtureRoot), []);

    writeFileSync(
      join(fixtureRoot, "s01_lesson", "helper.ts"),
      'import "../s02_lesson/code.ts";\nexport function runDemo() {}\n',
    );
    const helperIssues = runDependencyChecks(fixtureRoot);
    assert.ok(helperIssues.some((issue) => issue.code === "forward-import" && issue.message.includes("helper.ts")));
    assert.ok(helperIssues.some((issue) => issue.code === "legacy-production-marker" && issue.message.includes("helper.ts")));
    rmSync(join(fixtureRoot, "s01_lesson", "helper.ts"));

    writeFileSync(
      join(fixtureRoot, "s01_lesson", "code.ts"),
      'import "../s02_lesson/code.ts";\nexport function runDemo() {}\n',
    );
    writeFileSync(join(fixtureRoot, "shared", "model.ts"), "export const FauxProvider = true;\n");
    mkdirSync(join(fixtureRoot, "s14_extra"));
    writeFileSync(join(fixtureRoot, "s14_extra", "code.ts"), "export const extra = true;\n");
    const fixtureIssues = runDependencyChecks(fixtureRoot);
    const issueCodes = new Set(fixtureIssues.map((issue) => issue.code));
    assert.ok(issueCodes.has("lesson-count"));
    assert.ok(issueCodes.has("forward-import"));
    assert.ok(issueCodes.has("legacy-production-marker"));
    assert.ok(fixtureIssues.some((issue) => issue.message.includes("faux API")));

    const packageJson = JSON.parse(readFileSync(join(fixtureRoot, "package.json"), "utf8"));
    packageJson.dependencies["@mariozechner/pi-agent-core"] = "1.0.0";
    writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    assert.ok(runDependencyChecks(fixtureRoot).some((issue) => issue.code === "package-dependencies"));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  if (reportSuccess) console.log("check-deps self-test passed");
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
  } else {
    runSelfTest(false);
    const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const root = parseRootArgument(process.argv.slice(2), defaultRoot);
    const issues = runDependencyChecks(root);
    if (issues.length === 0) {
      console.log("Dependency checks passed: 13 lessons, ordered dependencies, live production paths");
    } else {
      console.error(`Dependency checks failed with ${issues.length} issue(s):`);
      for (const issue of issues) console.error(`- [${issue.code}] ${issue.message}`);
      process.exitCode = 1;
    }
  }
}
