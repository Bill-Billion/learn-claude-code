// Parsing for npm: and git: package sources. Split out of code.ts so the
// lesson's main file stays focused on the resolver; install-flow details like
// these are not part of the first pass through the course.

export function parseNpmName(source: string): string {
  const spec = source.slice("npm:".length);
  if (spec.startsWith("@")) {
    const parts = spec.split("@");
    const name = parts[0] && parts[1] ? `@${parts[1]}` : spec;
    const slash = name.indexOf("/");
    if (slash !== -1) {
      const rest = name.slice(slash + 1);
      return `${name.slice(0, slash)}/${rest.split("@")[0]}`;
    }
    return name;
  }
  return spec.split("@")[0] ?? spec;
}

export function parseGitSource(source: string): { host: string; path: string } | undefined {
  const hasGitPrefix = source.startsWith("git:");
  const trimmed = hasGitPrefix ? source.slice("git:".length) : source;
  const protocolMatch = trimmed.match(/^(https?|ssh|git):\/\/([^/]+)\/(.+)$/);

  if (protocolMatch) {
    return {
      host: stripGitUser(protocolMatch[2]!),
      path: stripGitSuffixAndRef(protocolMatch[3]!),
    };
  }

  if (!hasGitPrefix) {
    return undefined;
  }

  const shorthand = trimmed.startsWith("git@") ? trimmed.slice("git@".length) : trimmed;
  const match = shorthand.match(/^([^/:]+)(?::|\/)(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    host: stripGitUser(match[1]!),
    path: stripGitSuffixAndRef(match[2]!),
  };
}

function stripGitUser(host: string): string {
  return host.includes("@") ? host.split("@").at(-1)! : host;
}

function stripGitSuffixAndRef(path: string): string {
  return path.replace(/\.git(?:@.*)?$/, "").split("@")[0] ?? path;
}
