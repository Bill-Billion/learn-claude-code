# Contributing

Learn Agent Harness is a teaching repository with three independent courses. Contributions are welcome when they make a mechanism more accurate, more understandable, or easier to verify without obscuring the lesson behind production-scale machinery.

## Before Opening a Pull Request

1. Tie the change to a specific issue and explain the observed problem.
2. Keep one pull request focused on one course or one repository-wide concern.
3. Preserve the teaching boundary. Do not add abstractions, defensive layers, or framework machinery unless the lesson is about that mechanism.
4. Run the checks for every course you touch.
5. Disclose meaningful AI assistance and confirm that you reviewed the result yourself.

## Course Boundaries

### `learn-claude-code/`

The current course is the 22-lesson `sNN_topic/` track. The `agents/` and `docs/{en,zh,ja}/` trees are retained legacy material. Changes to a current lesson must keep `README.md`, `README.zh.md`, and `README.ja.md` synchronized, including identical code blocks.

```bash
cd learn-claude-code
python -m pytest -q

cd web
npm ci
npm run extract
npx tsc --noEmit
npm run build
```

### `learn-pi-agent/`

The 13 lessons form one cumulative TypeScript implementation. Keep the English, Chinese, and Japanese lesson guides synchronized. Source-trace notes must link to the pinned public upstream revision rather than a local source clone.

```bash
cd learn-pi-agent
npm ci
npm run check
```

### `learn-langchain/`

Each Chinese lesson contains a starter, a completed implementation, and offline tests. Live examples may use OpenAI, but automated checks must not require an API key or network-backed model call.

```bash
cd learn-langchain
uv sync --locked --extra dev
uv run python scripts/check_lessons.py
uv run ruff check .
uv run mypy shared scripts tests s*/code.py s*/starter.py
uv run pytest -q
```

## Root Documentation

Changes to course names, counts, prerequisites, runtime behavior, or learning routes must be reflected in `README.md`, `README-zh.md`, and `README-ja.md` together. Keep their heading order, tables, links, and technical claims aligned.

Do not commit dependency directories, caches, build output, generated Web extraction data, local source clones, internal plans, model workspace files, drafts, or backups. The repository hygiene workflow enforces the public tree and size budget.

---

# 贡献指南

Learn Agent Harness 包含三门彼此独立的教学课程。只要改动能让机制更准确、更易理解或更容易验证，同时不让生产级复杂度淹没教学重点，我们都欢迎贡献。

## 提交 Pull Request 前

1. 对应一个具体 Issue，并说明你实际观察到的问题。
2. 一个 Pull Request 只聚焦一门课程或一个仓库级问题。
3. 保持教学边界。除非课程本身就在讲相关机制，否则不要额外增加抽象、防御层或框架设施。
4. 运行所有被修改课程的检查。
5. 如实说明重要的 AI 协助，并确认你亲自审阅了结果。

## 课程边界

- `learn-claude-code/`：当前主线是 22 节 `sNN_topic/` 课程；`agents/` 与 `docs/{en,zh,ja}/` 是保留的旧版材料。修改当前课程时，三语 README 及其中代码块必须同步。
- `learn-pi-agent/`：13 节 TypeScript 课程共同组成一条累积主线。三语讲义必须同步，源码溯源必须指向固定的公开上游版本，不能依赖本地 Clone。
- `learn-langchain/`：每节中文课程包含 Starter、完整实现和离线测试。实际示例可以使用 OpenAI，但自动检查不能依赖 API Key 或联网模型调用。

课程改名、节数、前置条件、运行方式或学习路线发生变化时，必须同步修改根目录三个 README。不要提交依赖目录、缓存、构建产物、Web 生成数据、本地源码 Clone、内部计划、模型工作区、草稿或备份文件。
