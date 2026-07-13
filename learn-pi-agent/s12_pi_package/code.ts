import { basename, dirname, extname, isAbsolute, normalize, posix as pathPosix, relative, resolve, sep } from "node:path";

import { parseGitSource, parseNpmName } from "./source-parsing.ts";

export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export type MiniFiles = Record<string, string>;

export type PiManifest = {
  name?: string;
  keywords?: string[];
  pi?: Partial<Record<ResourceType, string[]>> & {
    image?: string;
    video?: string;
  };
};

export type PackageFilter = Partial<Record<ResourceType, string[]>>;

export type PackageEntry =
  | string
  | ({
      source: string;
    } & PackageFilter);

export type SourceScope = "user" | "project";

export type ResourceMetadata = {
  source: string;
  scope: SourceScope;
  origin: "package";
  baseDir: string;
};

export type ResolvedResource = {
  path: string;
  enabled: boolean;
  metadata: ResourceMetadata;
};

export type ResolvedPackageResources = Record<ResourceType, ResolvedResource[]>;

export type ResolvePiPackagesOptions = {
  files: MiniFiles;
  userPackages: PackageEntry[];
  projectPackages: PackageEntry[];
  projectTrusted: boolean;
  cwd?: string;
  agentDir?: string;
};

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

const RESOURCE_EXTENSIONS: Record<ResourceType, Set<string>> = {
  extensions: new Set([".ts", ".js"]),
  skills: new Set([".md"]),
  prompts: new Set([".md"]),
  themes: new Set([".json"]),
};

export function createPackageManifest(
  name: string,
  resources: Partial<Record<ResourceType, string[]>>,
): PiManifest {
  return {
    name,
    keywords: ["pi-package"],
    pi: { ...resources },
  };
}

export function resolvePiPackages(options: ResolvePiPackagesOptions): ResolvedPackageResources {
  const files = normalizeFiles(options.files);
  const cwd = normalizePath(options.cwd ?? "/repo");
  const agentDir = normalizePath(options.agentDir ?? "/home/me/.pi/agent");
  const accumulator = createAccumulator();

  const packageEntries = dedupePackageEntries([
    ...(options.projectTrusted ? options.projectPackages.map((pkg) => ({ pkg, scope: "project" as const })) : []),
    ...options.userPackages.map((pkg) => ({ pkg, scope: "user" as const })),
  ]);

  for (const entry of packageEntries) {
    const source = getPackageSource(entry.pkg);
    const filter = typeof entry.pkg === "string" ? undefined : entry.pkg;
    const root = resolvePackageRoot(files, source, entry.scope, cwd, agentDir);
    if (!root) {
      continue;
    }

    const metadata: ResourceMetadata = {
      source,
      scope: entry.scope,
      origin: "package",
      baseDir: dirname(root.kind === "file" ? root.path : joinPath(root.path, "package.json")),
    };

    if (root.kind === "file") {
      addResource(accumulator.extensions, root.path, metadata, true);
      continue;
    }

    collectPackageResources(files, root.path, accumulator, filter, metadata);
  }

  return toResolvedResources(accumulator);
}

export function getEnabledPaths(resources: ResolvedResource[]): string[] {
  return resources.filter((resource) => resource.enabled).map((resource) => resource.path);
}

export function discoverExtensionEntries(files: MiniFiles, root: string): string[] {
  return collectAutoExtensionEntries(normalizeFiles(files), root);
}

export function summarizeResolvedResources(resources: ResolvedPackageResources): Record<ResourceType, string[]> {
  return {
    extensions: getEnabledPaths(resources.extensions),
    skills: getEnabledPaths(resources.skills),
    prompts: getEnabledPaths(resources.prompts),
    themes: getEnabledPaths(resources.themes),
  };
}

function collectPackageResources(
  files: MiniFiles,
  packageRoot: string,
  accumulator: Record<ResourceType, Map<string, { metadata: ResourceMetadata; enabled: boolean }>>,
  filter: PackageFilter | undefined,
  metadata: ResourceMetadata,
): void {
  for (const resourceType of RESOURCE_TYPES) {
    const patterns = filter?.[resourceType];
    const mode = filter
      ? patterns === undefined
        ? "filtered-default"
        : "filtered-candidates"
      : "manifest-authoritative";
    const allFiles = collectPackageResourceFiles(files, packageRoot, resourceType, mode);

    if (patterns !== undefined) {
      const enabledPaths = applyPatterns(allFiles, patterns, packageRoot);
      for (const file of allFiles) {
        addResource(accumulator[resourceType], file, metadata, enabledPaths.has(file));
      }
      continue;
    }

    for (const file of allFiles) {
      addResource(accumulator[resourceType], file, metadata, true);
    }
  }
}

type PackageCollectionMode = "manifest-authoritative" | "filtered-default" | "filtered-candidates";

function collectPackageResourceFiles(
  files: MiniFiles,
  packageRoot: string,
  resourceType: ResourceType,
  mode: PackageCollectionMode,
): string[] {
  const manifest = readPiManifest(files, packageRoot)?.pi;
  const manifestEntries = manifest?.[resourceType];

  if (mode === "manifest-authoritative" && manifest) {
    return collectFilesFromEntries(files, packageRoot, manifestEntries ?? [], resourceType);
  }

  if (mode === "filtered-default" && manifestEntries) {
    return collectFilesFromEntries(files, packageRoot, manifestEntries, resourceType);
  }

  if (mode === "filtered-candidates" && manifestEntries && manifestEntries.length > 0) {
    return collectFilesFromEntries(files, packageRoot, manifestEntries, resourceType);
  }

  const conventionDir = joinPath(packageRoot, resourceType);
  return listResourceFiles(files, conventionDir, resourceType);
}

function collectFilesFromEntries(
  files: MiniFiles,
  packageRoot: string,
  entries: string[],
  resourceType: ResourceType,
): string[] {
  const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
  const collected = new Set<string>();

  for (const entry of sourceEntries) {
    const normalizedEntry = stripDotSlash(entry);
    if (hasGlobPattern(normalizedEntry)) {
      for (const path of collectManifestGlobMatches(files, packageRoot, normalizedEntry)) {
        if (hasFile(files, path)) {
          if (resourceTypeMatches(path, resourceType)) {
            collected.add(path);
          }
          continue;
        }

        for (const resourcePath of listResourceFiles(files, path, resourceType)) {
          collected.add(resourcePath);
        }
      }
      continue;
    }

    const absolutePath = joinPath(packageRoot, normalizedEntry);
    if (hasFile(files, absolutePath) && resourceTypeMatches(absolutePath, resourceType)) {
      collected.add(absolutePath);
      continue;
    }

    for (const path of listResourceFiles(files, absolutePath, resourceType)) {
      collected.add(path);
    }
  }

  const overridePatterns = entries.filter(isOverridePattern);
  if (overridePatterns.length === 0) {
    return Array.from(collected).sort();
  }
  return Array.from(applyPatterns(Array.from(collected), overridePatterns, packageRoot)).sort();
}

function collectManifestGlobMatches(files: MiniFiles, packageRoot: string, pattern: string): string[] {
  const candidates = new Set<string>();

  for (const file of Object.keys(files)) {
    const fileRelativePath = toPosix(relative(packageRoot, file));
    if (!isRelativeChildPath(fileRelativePath)) {
      continue;
    }

    candidates.add(file);
    let directory = dirname(file);
    while (directory !== packageRoot) {
      const directoryRelativePath = toPosix(relative(packageRoot, directory));
      if (!isRelativeChildPath(directoryRelativePath)) {
        break;
      }
      candidates.add(directory);
      directory = dirname(directory);
    }
  }

  const normalizedPattern = toPosix(pattern);
  return Array.from(candidates)
    .filter((path) => {
      const candidate = isAbsolute(normalizedPattern) ? path : toPosix(relative(packageRoot, path));
      return pathPosix.matchesGlob(candidate, normalizedPattern);
    })
    .sort();
}

function isRelativeChildPath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function applyPatterns(allFiles: string[], patterns: string[], packageRoot: string): Set<string> {
  if (patterns.length === 0) {
    return new Set();
  }

  let result = patterns.some((pattern) => !isOverridePattern(pattern))
    ? allFiles.filter((file) => patterns.some((pattern) => !isOverridePattern(pattern) && matchesPattern(file, pattern, packageRoot)))
    : [...allFiles];

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      result = result.filter((file) => !matchesPattern(file, pattern.slice(1), packageRoot));
    }
  }
  for (const pattern of patterns) {
    if (pattern.startsWith("+")) {
      for (const file of allFiles) {
        if (!result.includes(file) && matchesExactPath(file, pattern.slice(1), packageRoot)) {
          result.push(file);
        }
      }
    }
  }
  for (const pattern of patterns) {
    if (pattern.startsWith("-")) {
      result = result.filter((file) => !matchesExactPath(file, pattern.slice(1), packageRoot));
    }
  }

  return new Set(result.sort());
}

function resolvePackageRoot(
  files: MiniFiles,
  source: string,
  scope: SourceScope,
  cwd: string,
  agentDir: string,
): { kind: "file" | "directory"; path: string } | undefined {
  const resolvedPath = resolvePackageSourcePath(source, scope, cwd, agentDir);
  if (hasFile(files, resolvedPath)) {
    return { kind: "file", path: resolvedPath };
  }
  if (hasDirectory(files, resolvedPath)) {
    return { kind: "directory", path: resolvedPath };
  }
  return undefined;
}

function resolvePackageSourcePath(source: string, scope: SourceScope, cwd: string, agentDir: string): string {
  if (source.startsWith("npm:")) {
    const name = parseNpmName(source);
    const root = scope === "project" ? joinPath(cwd, ".pi", "npm", "node_modules") : joinPath(agentDir, "npm", "node_modules");
    return joinPath(root, name);
  }

  const git = parseGitSource(source);
  if (git) {
    const root = scope === "project" ? joinPath(cwd, ".pi", "git") : joinPath(agentDir, "git");
    return joinPath(root, git.host, git.path);
  }

  if (isAbsolute(source)) {
    return normalizePath(source);
  }

  const baseDir = scope === "project" ? joinPath(cwd, ".pi") : agentDir;
  return joinPath(baseDir, source);
}

function readPiManifest(files: MiniFiles, packageRoot: string): PiManifest | undefined {
  const raw = files[joinPath(packageRoot, "package.json")];
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as PiManifest;
  } catch {
    return undefined;
  }
}

function listResourceFiles(files: MiniFiles, root: string, resourceType: ResourceType): string[] {
  if (resourceType === "extensions") {
    return collectAutoExtensionEntries(files, root);
  }

  const normalizedRoot = stripTrailingSlash(normalizePath(root));
  return Object.keys(files)
    .filter((path) => path.startsWith(`${normalizedRoot}/`) && resourceTypeMatches(path, resourceType))
    .sort();
}

function collectAutoExtensionEntries(files: MiniFiles, root: string): string[] {
  const normalizedRoot = stripTrailingSlash(normalizePath(root));
  const explicitRootEntries = resolveExtensionEntries(files, normalizedRoot);
  if (explicitRootEntries) {
    return explicitRootEntries;
  }

  const entries = new Set<string>();
  const childDirectories = new Set<string>();

  for (const path of Object.keys(files).sort()) {
    if (!path.startsWith(`${normalizedRoot}/`)) {
      continue;
    }

    const relativePath = toPosix(relative(normalizedRoot, path));
    const [firstSegment, ...rest] = relativePath.split("/");
    if (!firstSegment || firstSegment.startsWith(".") || firstSegment === "node_modules") {
      continue;
    }

    if (rest.length === 0) {
      if (resourceTypeMatches(path, "extensions")) {
        entries.add(path);
      }
      continue;
    }

    childDirectories.add(joinPath(normalizedRoot, firstSegment));
  }

  for (const childDirectory of Array.from(childDirectories).sort()) {
    for (const path of resolveExtensionEntries(files, childDirectory) ?? []) {
      entries.add(path);
    }
  }

  return Array.from(entries).sort();
}

function resolveExtensionEntries(files: MiniFiles, directory: string): string[] | undefined {
  const manifestEntries = readPiManifest(files, directory)?.pi?.extensions;
  if (manifestEntries?.length) {
    const entries = manifestEntries
      .map((entry) => joinPath(directory, stripDotSlash(entry)))
      .filter((path) => hasFile(files, path) && resourceTypeMatches(path, "extensions"));
    if (entries.length > 0) {
      return Array.from(new Set(entries)).sort();
    }
  }

  const indexTs = joinPath(directory, "index.ts");
  if (hasFile(files, indexTs)) {
    return [indexTs];
  }

  const indexJs = joinPath(directory, "index.js");
  if (hasFile(files, indexJs)) {
    return [indexJs];
  }

  return undefined;
}

function resourceTypeMatches(path: string, resourceType: ResourceType): boolean {
  if (resourceType === "skills") {
    return basename(path) === "SKILL.md" || (dirname(path).endsWith("/skills") && extname(path) === ".md");
  }
  return RESOURCE_EXTENSIONS[resourceType].has(extname(path));
}

function matchesPattern(path: string, pattern: string, packageRoot: string): boolean {
  const relativePath = toPosix(relative(packageRoot, path));
  const name = basename(path);
  const absolutePath = toPosix(path);
  const candidates = [relativePath, name, absolutePath];

  if (name === "SKILL.md") {
    const parentDirectory = dirname(path);
    candidates.push(
      toPosix(relative(packageRoot, parentDirectory)),
      basename(parentDirectory),
      toPosix(parentDirectory),
    );
  }

  const normalizedPattern = toPosix(pattern);
  return candidates.some((candidate) => pathPosix.matchesGlob(candidate, normalizedPattern));
}

function matchesExactPath(path: string, pattern: string, packageRoot: string): boolean {
  const normalizedPattern = normalizeExactPattern(pattern);
  const relativePath = toPosix(relative(packageRoot, path));
  const absolutePath = toPosix(path);
  if (normalizedPattern === relativePath || normalizedPattern === absolutePath) {
    return true;
  }

  if (basename(path) !== "SKILL.md") {
    return false;
  }

  const parentDirectory = dirname(path);
  const parentRelativePath = toPosix(relative(packageRoot, parentDirectory));
  return normalizedPattern === parentRelativePath || normalizedPattern === toPosix(parentDirectory);
}

function normalizeExactPattern(pattern: string): string {
  const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
  return toPosix(normalized);
}

function dedupePackageEntries(
  entries: Array<{ pkg: PackageEntry; scope: SourceScope }>,
): Array<{ pkg: PackageEntry; scope: SourceScope }> {
  const seen = new Map<string, { pkg: PackageEntry; scope: SourceScope }>();

  for (const entry of entries) {
    const identity = packageIdentity(getPackageSource(entry.pkg), entry.scope);
    const existing = seen.get(identity);
    if (!existing || (entry.scope === "project" && existing.scope === "user")) {
      seen.set(identity, entry);
    }
  }

  return Array.from(seen.values());
}

function packageIdentity(source: string, scope: SourceScope): string {
  if (source.startsWith("npm:")) {
    return `npm:${parseNpmName(source)}`;
  }
  const git = parseGitSource(source);
  if (git) {
    return `git:${git.host}/${git.path}`;
  }
  return `local:${scope}:${source}`;
}

function getPackageSource(pkg: PackageEntry): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

function addResource(
  map: Map<string, { metadata: ResourceMetadata; enabled: boolean }>,
  path: string,
  metadata: ResourceMetadata,
  enabled: boolean,
): void {
  if (!map.has(path)) {
    map.set(path, { metadata: { ...metadata }, enabled });
  }
}

function toResolvedResources(
  accumulator: Record<ResourceType, Map<string, { metadata: ResourceMetadata; enabled: boolean }>>,
): ResolvedPackageResources {
  return {
    extensions: mapResources(accumulator.extensions),
    skills: mapResources(accumulator.skills),
    prompts: mapResources(accumulator.prompts),
    themes: mapResources(accumulator.themes),
  };
}

function mapResources(map: Map<string, { metadata: ResourceMetadata; enabled: boolean }>): ResolvedResource[] {
  return Array.from(map.entries())
    .map(([path, { metadata, enabled }]) => ({ path, enabled, metadata }))
    .sort((a, b) => scopeRank(a.metadata.scope) - scopeRank(b.metadata.scope) || a.path.localeCompare(b.path));
}

function scopeRank(scope: SourceScope): number {
  return scope === "project" ? 0 : 1;
}

function createAccumulator(): Record<ResourceType, Map<string, { metadata: ResourceMetadata; enabled: boolean }>> {
  return {
    extensions: new Map(),
    skills: new Map(),
    prompts: new Map(),
    themes: new Map(),
  };
}

function hasFile(files: MiniFiles, path: string): boolean {
  return Object.hasOwn(files, normalizePath(path));
}

function hasDirectory(files: MiniFiles, path: string): boolean {
  const normalizedPath = stripTrailingSlash(normalizePath(path));
  return Object.keys(files).some((file) => file.startsWith(`${normalizedPath}/`));
}

function normalizeFiles(files: MiniFiles): MiniFiles {
  const normalized: MiniFiles = {};
  for (const [path, content] of Object.entries(files)) {
    normalized[normalizePath(path)] = content;
  }
  return normalized;
}

function hasGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function isOverridePattern(pattern: string): boolean {
  return pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-");
}

function stripDotSlash(path: string): string {
  return toPosix(path).replace(/^\.\//, "");
}

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.join(sep));
}

function normalizePath(path: string): string {
  return toPosix(normalize(resolve(path)));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function demo(): Promise<void> {
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
    "/packages/review/skills/review/SKILL.md": "# Review skill",
    "/packages/review/prompts/review.md": "Review this diff.",
    "/packages/review/themes/review.json": "{}",
  };
  const resolved = resolvePiPackages({
    files,
    userPackages: ["/packages/review"],
    projectPackages: [],
    projectTrusted: true,
  });

  console.log(`Extensions: ${getEnabledPaths(resolved.extensions).length}`);
  console.log(`Skills: ${getEnabledPaths(resolved.skills).length}`);
  console.log(`Prompts: ${getEnabledPaths(resolved.prompts).length}`);
  console.log(`Themes: ${getEnabledPaths(resolved.themes).length}`);
}

if (process.argv.includes("--demo")) {
  await demo();
}
