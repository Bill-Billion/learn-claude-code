# Learn Agent Harness Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the existing Claude Code, Pi Agent, and LangChain learning projects into a clean, trilingual `learn-agent-harness` monorepo and publish the integration branch to Bill-Billion without shipping internal planning or generated artifacts.

**Architecture:** Start from a fresh clone of Bill-Billion's `main`, merge only the remote `rewrite/lecture-style` tip, and resolve conflicts at file level so mainline fixes and the rewritten course content both survive. Each course remains independently installable and testable under a top-level directory, while the root contains only the public portal, contributor guidance, license, ignore rules, and repository-wide CI.

**Tech Stack:** Git, Markdown, Python 3.11, pytest, uv, Ruff, Mypy, Node.js 20/25, npm, TypeScript, Vite, GitHub Actions, POSIX shell.

## Global Constraints

- Publish branch: `codex/learn-agent-harness-monorepo` in `Bill-Billion/learn-claude-code` until the repository is renamed.
- Do not push local commits after remote `origin/rewrite/lecture-style` commit `c05ed94`.
- Final root directories are exactly the public root files, `.github/workflows/`, `learn-claude-code/`, `learn-pi-agent/`, and `learn-langchain/`.
- Do not publish `docs/superpowers`, specifications, plans, `.claude`, `.codex`, `.agents`, `.serena`, `.superpowers`, `AGENTS.md`, or `CLAUDE.md`.
- Do not publish dependency directories, nested repositories, caches, source-reference clones, build logs, drafts, backups, or generated Web data.
- Remove `learn-claude-code/web/src/data/generated/{docs,versions}.json` and duplicated `learn-claude-code/web/public/course-assets/`.
- Keep `learn-claude-code/skills/agent-builder/references/` because it is a learner-facing s07 fixture.
- Convert Pi local `reference/pi` links to pinned `earendil-works/pi` URLs at commit `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`.
- Convert Pi claw0 attribution to pinned `shareAI-lab/claw0` URLs at commit `0090e863bd90aaebc79d244223cc2acc7c284eaf`.
- Rename the imported LangChain project and all public references from `learn-langchain-beginner` to `learn-langchain`.
- Final tracked size must be no more than 4,718,592 bytes, with no tracked file larger than 1,048,576 bytes.
- All three courses must pass their own checks without network-backed model calls.

---

### Task 1: Prepare the clean integration branch

**Files:**
- Working clone: `/Users/yanghaoran/Code/learn-agent-harness`
- No public files are changed by this task.

**Interfaces:**
- Consumes: `origin/main` and remote `origin/rewrite/lecture-style`.
- Produces: a clean `codex/learn-agent-harness-monorepo` branch containing an explicit merge commit.

- [ ] **Step 1: Clone the Bill-Billion repository and configure push transport**

```bash
git clone https://github.com/Bill-Billion/learn-claude-code.git /Users/yanghaoran/Code/learn-agent-harness
git -C /Users/yanghaoran/Code/learn-agent-harness remote set-url --push origin git@github.com:Bill-Billion/learn-claude-code.git
git -C /Users/yanghaoran/Code/learn-agent-harness fetch origin main rewrite/lecture-style
```

Expected: the target begins at the fetched Bill-Billion repository and has no local untracked files.

- [ ] **Step 2: Create the integration branch from main**

```bash
git -C /Users/yanghaoran/Code/learn-agent-harness switch -c codex/learn-agent-harness-monorepo origin/main
git -C /Users/yanghaoran/Code/learn-agent-harness rev-parse HEAD
```

Expected: `HEAD` is the current `origin/main` commit and the branch name is `codex/learn-agent-harness-monorepo`.

- [ ] **Step 3: Merge the remote lecture rewrite**

```bash
git -C /Users/yanghaoran/Code/learn-agent-harness merge --no-ff origin/rewrite/lecture-style
```

Expected: either a merge commit, or conflicts limited to files changed on both lines. Resolve each conflict by retaining mainline code/CI/contributor fixes and rewritten trilingual lesson content, then commit the merge.

- [ ] **Step 4: Record baseline test results**

```bash
cd /Users/yanghaoran/Code/learn-agent-harness
python3 -m pytest -q
cd web && npm ci && npm run extract && npx tsc --noEmit && npm run build
```

Expected: Python tests and the Web extraction/typecheck/build pass before directory relocation.

### Task 2: Relocate and clean the Claude Code course

**Files:**
- Move: current course files to `learn-claude-code/`
- Move: `README.md` to `learn-claude-code/README.md`
- Move: `README.zh-CN.md` to `learn-claude-code/README.zh-CN.md`
- Move: `README.ja.md` to `learn-claude-code/README.ja.md`
- Delete: `learn-claude-code/docs/superpowers/`
- Delete: `learn-claude-code/web/src/data/generated/docs.json`
- Delete: `learn-claude-code/web/src/data/generated/versions.json`
- Delete: `learn-claude-code/web/public/course-assets/`

**Interfaces:**
- Consumes: merged Claude course tree from Task 1.
- Produces: a self-contained `learn-claude-code/` course with three language entry pages and no generated duplicates.

- [ ] **Step 1: Create an explicit publish allowlist and move tracked course files**

Use `git ls-files -z` and a NUL-safe loop to relocate tracked course content while leaving root `LICENSE`, future root portal files, `.github`, and excluded internal files outside the course. Never copy untracked files from the original working directory.

- [ ] **Step 2: Remove generated and internal artifacts**

```bash
git rm -r --ignore-unmatch learn-claude-code/docs/superpowers
git rm --ignore-unmatch learn-claude-code/web/src/data/generated/docs.json learn-claude-code/web/src/data/generated/versions.json
git rm -r --ignore-unmatch learn-claude-code/web/public/course-assets
```

Expected: the learner-owned chapter images remain, while the duplicate generated assets and plans are absent.

- [ ] **Step 3: Correct course-local navigation and counts**

Update all three course README files so they identify the 22-lesson Claude Code course, link only to files under `learn-claude-code/`, and do not present themselves as the monorepo root.

- [ ] **Step 4: Verify the relocated course**

```bash
cd /Users/yanghaoran/Code/learn-agent-harness/learn-claude-code
python3 -m pytest -q
cd web && npm ci && npm run extract && npx tsc --noEmit && npm run build
```

Expected: results match or improve on the Task 1 baseline.

- [ ] **Step 5: Commit the structural assembly**

```bash
git add -A
git commit -m "refactor: assemble learn-agent-harness monorepo"
```

### Task 3: Import and sanitize the Pi Agent course

**Files:**
- Create: `learn-pi-agent/` from `/Users/yanghaoran/Code/learn-pi-agent`
- Modify: `learn-pi-agent/README.md`
- Modify: `learn-pi-agent/README.zh-CN.md`
- Modify: `learn-pi-agent/README.ja.md`
- Modify: `learn-pi-agent/package-lock.json`
- Modify: `learn-pi-agent/**/pi-source*.md`

**Interfaces:**
- Consumes: learner-facing source files from the standalone Pi course.
- Produces: 99 public course files with pinned, browser-accessible source links and official npm registry URLs.

- [ ] **Step 1: Copy only the reviewed 99-file publish allowlist**

Exclude `node_modules/`, `reference/pi/`, `reference/claw0/`, `.DS_Store`, `*.bak`, `设计规范.md`, hidden agent configuration, and `docs/superpowers/` while copying.

- [ ] **Step 2: Rewrite source-trace links deterministically**

Replace file links beginning with `reference/pi/` by `https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/`; use `/tree/` for directory links. Apply the same pinned-link rule to claw0 using commit `0090e863bd90aaebc79d244223cc2acc7c284eaf`.

- [ ] **Step 3: Normalize package-lock registry hosts**

Replace only `https://registry.npmmirror.com/` with `https://registry.npmjs.org/`; preserve package versions and integrity hashes.

- [ ] **Step 4: Verify no local references remain and run checks**

```bash
cd /Users/yanghaoran/Code/learn-agent-harness/learn-pi-agent
! rg 'reference/(pi|claw0)' --glob '*.md'
npm ci
npm run check
```

Expected: no local source-clone links and all 78 Pi checks pass.

### Task 4: Import and rename the LangChain course

**Files:**
- Create: `learn-langchain/` from `/Users/yanghaoran/Code/learn-langchain-beginner`
- Modify: `learn-langchain/README.md`
- Modify: `learn-langchain/pyproject.toml`
- Modify: `learn-langchain/uv.lock`
- Modify: `learn-langchain/scripts/check_lessons.py`
- Modify: `learn-langchain/.gitignore`
- Modify: `learn-langchain/s01_models/README.md` through `learn-langchain/s13_comprehensive_project/README.md`

**Interfaces:**
- Consumes: reviewed 82-file LangChain publish allowlist.
- Produces: a Chinese `learn-langchain` course whose tests and tooling contain no old repository name or internal report dependency.

- [ ] **Step 1: Copy only the reviewed 82-file publish allowlist**

Exclude `.venv/`, caches, `.references/`, `.serena/`, `.claude/`, `.github/`, `deep-research-report.md`, all `docs/`, `cf-build-log.json`, `.DS_Store`, and dependency/build output.

- [ ] **Step 2: Rename the project and public commands**

Set the package name to `learn-langchain`, use the heading `Learn LangChain：从 Model 到 Agent 与 RAG`, update all 13 `cd learn-langchain-beginner` commands to `cd learn-langchain`, and make the sibling Claude course link relative to `../learn-claude-code/`.

- [ ] **Step 3: Remove internal-report coupling**

Delete the README sections that advertise `deep-research-report.md` or `.references/`, update the lesson checker docstring to describe the public course contract directly, and remove `.references` from Ruff, Mypy, and ignore configuration.

- [ ] **Step 4: Regenerate the lock and verify**

```bash
cd /Users/yanghaoran/Code/learn-agent-harness/learn-langchain
uv lock
uv sync --locked --extra dev
uv run python scripts/check_lessons.py
uv run ruff check .
uv run mypy shared scripts tests s*/code.py s*/starter.py
uv run pytest -q
! rg 'learn-langchain-beginner|deep-research-report|\.references'
```

Expected: lockfile names the new project and all static checks/tests pass offline.

### Task 5: Build the trilingual root portal and contributor surface

**Files:**
- Create: `README.md`
- Create: `README-zh.md`
- Create: `README-ja.md`
- Modify: `CONTRIBUTING.md`
- Modify: `.gitignore`
- Keep: `LICENSE`

**Interfaces:**
- Consumes: accurate course capabilities and paths from Tasks 2-4.
- Produces: three synchronized portal pages plus repository-wide contribution and hygiene rules.

- [ ] **Step 1: Write the English portal**

Lead with `Learn Agent Harness`, then show the three-course comparison and learning routes before the shared harness thesis. State the exact language/API/offline status: Claude Code has 22 trilingual Python lessons and uses Anthropic in live examples; Pi has 13 trilingual TypeScript lessons and is fully offline; LangChain has 13 Chinese Python lessons with offline tests and OpenAI-backed live examples.

- [ ] **Step 2: Translate the portal without changing its structure**

Create `README-zh.md` and `README-ja.md` with the same headings, tables, links, course facts, and learning routes as the English source. Keep product names and shell commands literal.

- [ ] **Step 3: Generalize contribution and ignore rules**

Update `CONTRIBUTING.md` to cover changes within each course and root synchronization. Add ignores for dependency directories, caches, hidden agent workspaces, local source clones, build output, drafts, backups, and generated Web extraction files without ignoring required teaching fixtures.

- [ ] **Step 4: Validate links and language parity**

Run a Markdown link checker or an equivalent local script over all three root README files, then compare their heading sequences and table row counts. Expected: every relative link resolves and the structural sequences match.

- [ ] **Step 5: Commit public documentation**

```bash
git add README.md README-zh.md README-ja.md CONTRIBUTING.md .gitignore learn-claude-code learn-pi-agent learn-langchain
git commit -m "docs: establish three-course harness learning paths"
```

- [ ] **Step 6: Commit pinned source-link cleanup separately if it remains unstaged**

```bash
git add learn-pi-agent
git commit -m "docs: replace local source references with pinned links"
```

Expected: skip the second commit only when the Pi link changes are already part of a logically complete prior commit.

### Task 6: Add independent CI and repository hygiene gates

**Files:**
- Create: `.github/workflows/claude-code.yml`
- Create: `.github/workflows/pi-agent.yml`
- Create: `.github/workflows/langchain.yml`
- Create: `.github/workflows/repository-hygiene.yml`
- Delete: `.github/workflows/sync-upstream.yml`

**Interfaces:**
- Consumes: commands proven locally by Tasks 2-4.
- Produces: four required workflows that always run on pull requests to `main` and pushes to `main`.

- [ ] **Step 1: Add the Claude workflow**

Use Python 3.11 for `python -m pytest -q`; use Node 20 with npm caching keyed to `learn-claude-code/web/package-lock.json`, followed by `npm ci`, `npm run extract`, `npx tsc --noEmit`, and `npm run build`.

- [ ] **Step 2: Add the Pi workflow**

Use Node 25, cache `learn-pi-agent/package-lock.json`, then run `npm ci` and `npm run check` from `learn-pi-agent/`.

- [ ] **Step 3: Add the LangChain workflow**

Use Python 3.11 and `astral-sh/setup-uv`, then run `uv sync --locked --extra dev`, the lesson checker, Ruff, Mypy, and pytest from `learn-langchain/`.

- [ ] **Step 4: Add the hygiene workflow**

Use `git ls-files -z` to reject tracked totals over 4,718,592 bytes, individual files over 1,048,576 bytes, gitlinks, and the explicit banned path/file patterns from Global Constraints. Do not reject `learn-claude-code/skills/agent-builder/references/`.

- [ ] **Step 5: Remove obsolete upstream sync and lint workflows**

```bash
git rm --ignore-unmatch .github/workflows/sync-upstream.yml
python3 -c 'import pathlib, yaml; [yaml.safe_load(p.read_text()) for p in pathlib.Path(".github/workflows").glob("*.yml")]'
```

Expected: four workflow files parse successfully and none uses path filters.

- [ ] **Step 6: Commit CI**

```bash
git add .github/workflows
git commit -m "ci: validate each course independently"
```

### Task 7: Release verification and remote publication

**Files:**
- Verify: entire tracked tree and Git history.
- Temporary verification clone: a new directory outside `/Users/yanghaoran/Code/learn-agent-harness`.

**Interfaces:**
- Consumes: the completed integration branch.
- Produces: a pushed Bill-Billion remote branch with reproducible verification evidence.

- [ ] **Step 1: Run all course checks from the final tracked tree**

Repeat the exact Claude, Pi, and LangChain commands from Tasks 2-4 after the last commit. Expected: every suite, typecheck, and build passes from current `HEAD`.

- [ ] **Step 2: Run repository hygiene checks**

```bash
git diff --check
git status --short
git ls-files -s | awk '$1 == "160000" { print; bad=1 } END { exit bad }'
git ls-files -z | xargs -0 stat -f '%z %N' | sort -nr | head -20
git ls-files -z | xargs -0 stat -f '%z' | awk '{ total += $1; if ($1 > 1048576) bad=1 } END { print total; if (total > 4718592 || bad) exit 1 }'
```

Expected: no whitespace errors, clean status, no gitlinks, no file over 1 MiB, and total no more than 4.5 MiB.

- [ ] **Step 3: Audit the publish tree for banned material**

Search tracked paths and contents for hidden agent directories, plans/specifications, source-reference clones, local absolute paths, old repository names, generated course assets, dependency directories, caches, drafts, and backup suffixes. Expected: zero matches except documented learner-facing fixtures explicitly allowed by Global Constraints.

- [ ] **Step 4: Verify from a fresh clone of the branch**

Clone the local repository into a new temporary directory with `--branch codex/learn-agent-harness-monorepo`, confirm the same tracked size/file count, and rerun the fast offline test suites plus all README link checks. Expected: results reproduce without untracked local state.

- [ ] **Step 5: Push the integration branch**

```bash
git push -u origin codex/learn-agent-harness-monorepo
```

Expected: `origin/codex/learn-agent-harness-monorepo` resolves to local `HEAD` in `Bill-Billion/learn-claude-code`.

- [ ] **Step 6: Report publication boundaries**

Report the remote branch URL, commit sequence, exact tracked file count and byte size, verification results, and explicitly state that GitHub repository renaming and merging to `main` remain separate cutover actions.
