# Learn Agent Harness Monorepo 合并设计

**状态：** 待用户审阅

**日期：** 2026-07-13

**源仓库：** `Bill-Billion/learn-claude-code`

**源分支：** `rewrite/lecture-style`

**目标仓库名：** `Bill-Billion/learn-agent-harness`

## 1. 设计摘要

本次工作不是在现有仓库中简单增加两个目录，而是把单课程仓库升级为一个多课程学习仓库。

合并后的仓库遵循四条原则：

1. 保留 `learn-claude-code` 的完整 Git 历史。
2. 三门课程各自管理依赖、运行方式、测试和课程叙事。
3. 根目录只负责统一品牌、概念模型、课程导航、仓库级 CI 和许可。
4. 第三方参考源码不进入主仓库，课程中的源码溯源使用固定提交链接。

最终课程名称确定为：

- `learn-claude-code`
- `learn-pi-agent`
- `learn-langchain`

`beginner` 只作为 `learn-langchain` 的难度标签，不再进入目录名、项目名或课程品牌。

## 2. 目标与非目标

### 2.1 目标

- 将仓库品牌从 Learn Claude Code 升级为 Learn Agent Harness。
- 在同一个仓库中提供三条互补的 Agent Harness 学习路径。
- 将现有 Claude Code 课程整体移动到 `learn-claude-code/`。
- 以干净快照导入 `learn-pi-agent/` 和 `learn-langchain/`。
- 将根 README 改造成三语的总纲和选课入口。
- 保证三门课程可分别安装、运行和验证。
- 建立按课程隔离的 GitHub Actions。
- 完成 GitHub 仓库改名、远端地址和部署路径切换。

### 2.2 非目标

- 不把三门课程做成统一的 Python workspace、npm workspace 或 monorepo 构建系统。
- 不在本次合并中把 `learn-langchain` 的 13 节课程翻译成英文或日文。
- 不重写三门课程的教学正文。
- 不把 Pi、LangChain 或 claw0 的参考源码复制进仓库。
- 不把现有 Claude Web 改造成三门课程的统一网站。
- 不修订 Claude Web 当前仍使用旧 12 节内容的问题。
- 不降低 `learn-pi-agent` 当前的 Node.js `>=25` 要求，除非另行完成兼容性验证。
- 不删除当前工作区中的任何未跟踪文件或本地参考副本。

## 3. 当前基线

### 3.1 Git 基线

- 当前分支：`rewrite/lecture-style`
- 设计分析时的课程基线提交：`c05ed94`
- `origin`：fetch 使用 `https://github.com/Bill-Billion/learn-claude-code.git`，push 使用 `git@github.com:Bill-Billion/learn-claude-code.git`
- `shareai`：`shareAI-lab/learn-claude-code`
- `upstream`：当前重复指向 `Bill-Billion/learn-claude-code`，迁移工作区不保留该重复 remote
- `origin/main` 是 GitHub 默认分支；它与 `rewrite/lecture-style` 已经发生双向分叉。
- 分析时 `origin/main...rewrite/lecture-style` 的提交计数为 `23 30`，迁移前必须先做显式集成，不能直接假定可 fast-forward。
- 当前工作区存在未跟踪内容，不能直接作为迁移工作区。

### 3.2 三门课程现状

| 课程 | 当前形态 | 技术栈 | 课程规模 | 语言 | 验证方式 |
|---|---|---|---|---|---|
| Learn Claude Code | 当前 Git 仓库 | Python + Anthropic API + Next.js Web | 22 节新主线，12 节旧 Web 内容 | 英中日 | Pytest + Web build |
| Learn Pi Agent | 普通目录，不是 Git 仓库 | TypeScript + Node.js `>=25` | 13 节 | 英中日，源码溯源英中 | TypeScript check + 78 tests |
| Learn LangChain | 普通目录，不是 Git 仓库 | Python `>=3.11` + uv + LangChain 1.x | 13 节 | 中文 | 结构检查 + Ruff + Mypy + Pytest |

### 3.3 当前工作区冲突

当前 `.gitignore` 明确忽略：

```gitignore
/learn-claude-code/
/learn-pi-agent/
```

而当前工作区已经存在：

- `./learn-claude-code/`，约 788 MB
- `./learn-pi-agent/`，约 37 MB
- `./web/`，约 417 MB，包含本地构建依赖和产物

因此实现阶段必须使用干净 clone 或独立迁移工作区，不能在当前目录覆盖同名路径。

## 4. 目标目录

```text
learn-agent-harness/
├── README.md
├── README-zh.md
├── README-ja.md
├── LICENSE
├── CONTRIBUTING.md
├── .gitignore
├── .github/
│   └── workflows/
│       ├── claude-code.yml
│       ├── pi-agent.yml
│       ├── langchain.yml
│       └── repository-hygiene.yml
├── learn-claude-code/
│   ├── README.md
│   ├── README-zh.md
│   ├── README-ja.md
│   ├── .env.example
│   ├── requirements.txt
│   ├── s01_agent_loop/
│   ├── ...
│   ├── s22_goal_loop/
│   ├── agents/
│   ├── skills/
│   ├── tests/
│   ├── docs/
│   └── web/
├── learn-pi-agent/
│   ├── README.md
│   ├── README.zh.md
│   ├── README.ja.md
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   └── s01_agent_loop/ ... s13_integrated_harness/
└── learn-langchain/
    ├── README.md
    ├── CONTRIBUTING.md
    ├── .env.example
    ├── pyproject.toml
    ├── uv.lock
    ├── s01_first_model/ ... s13_comprehensive_project/
    ├── shared/
    ├── scripts/
    └── tests/
```

目录命名不在本次合并中统一 README 的语言后缀。Claude 继续使用 `README-zh.md`，Pi 继续使用 `README.zh.md`。根 README 显式链接正确文件，避免为了形式一致引入大范围无价值改名。

最终公开树不包含 `docs/superpowers/`、规格、实施计划、研究报告、模型工作说明或本机路径记录。设计与实施文档只保留在本地规划分支，不进入最终集成分支和远端默认分支。

### 4.1 最终体积预算

按当前文件逐个执行 `stat` 得到的发布白名单基线为：

| 内容 | 文件数 | Bytes | MiB |
|---|---:|---:|---:|
| Claude 课程与现有根级公开文件 | 310 | 2,692,047 | 2.567 |
| Pi 课程 | 99 | 812,726 | 0.775 |
| LangChain 课程 | 82 | 617,999 | 0.589 |
| 合计基线 | 491 | 4,122,772 | 3.932 |

该基线尚未加入新的三语根 README、通用 `CONTRIBUTING.md` 和新增 workflow，但这些都是小型文本文件。最终 HEAD 的目标为约 497 个 tracked 文件、4.0 至 4.2 MiB，硬上限为 4.5 MiB。超过 4.5 MiB 视为迁移失败，必须先定位意外文件，不能直接放宽上限。

当前三部分白名单的 gzip 内容流合计约 1.20 MiB；加入新根文档后，GitHub source archive 预计约 1.3 至 1.5 MiB。

当前仓库 `.git` 目录约 10 MiB。保留 Claude 历史并加入两门新课程后，预计 `.git` 为 11 至 13 MiB，因此一次完整 clone 在未安装依赖时预计占用约 15 至 18 MiB。工作区体积和 Git 历史体积必须分开报告。

上述体积不包含依赖安装后的 `.venv`、`node_modules`、Web build、模型参考 clone 或任何缓存。

### 4.2 文件类型边界

以下是课程交付物，应保留：

- 三语课程 README、章节正文、代码、测试和最终图示。
- Claude 的 `agents/`、旧课程 `docs/{en,zh,ja}` 和 Web 源码。
- Claude `skills/agent-builder/references/`。这些文件是 s07 可运行教学 fixture，会被课程示例实际加载，不是仓库设计期给模型使用的内部材料。
- Pi 的 `pi-source*.md`。它们是面向学习者的公开源码溯源内容，但其中本地路径必须转换为固定 GitHub 链接。
- LangChain 的 starter、solution、离线测试、流程图和 s11 至 s13 的课程知识文件。

以下一律不是课程交付物，不进入最终 HEAD：

- Superpowers 规格、计划、模型提示词、Agent 工作说明和本机配置。
- Deep research、course design analysis、alignment audit 和 source alignment 等设计期报告。
- `.references`、`reference/pi`、`reference/claw0` 和其他源码 clone。
- Web 生成 JSON、复制到 public 的重复课程图片、构建产物和依赖目录。
- 草图、中间稿、备份、失败日志、缓存和虚拟环境。

该约束针对最终 HEAD、GitHub 默认分支和 source archive。为了保留 Claude 课程历史，旧提交中已经存在的历史文件对象不会通过 `git filter-repo` 擦除；本次新写的合并规格和实施计划不推送，因此不会新增到远端历史。若要求连旧提交中的历史对象也不可访问，就必须单独批准破坏性的全仓库历史重写，这不属于当前方案。

## 5. 仓库边界

### 5.1 根目录职责

根目录只负责：

- Learn Agent Harness 品牌和共同概念。
- 三门课程的对照、选课建议和入口。
- 根级许可和全仓库忽略规则。
- GitHub Actions 的统一入口。
- 面向三门课程的统一贡献入口。

根目录不提供统一安装命令，不假装三门课程共享一个运行时。

### 5.2 课程目录职责

每门课程必须满足：

- 可以只阅读本课程 README 理解课程目的、边界和运行方式。
- 安装命令只影响本课程目录。
- 测试命令从本课程目录运行。
- 课程内部链接不依赖另外两门课程的本地文件。
- 课程可以独立演进，不要求三门课程同步章节数量或技术栈。

## 6. 根 README 信息架构

根 README 保留现有文档关于 Agency 和 Harness 的核心观点，但不再承担 Claude Code 课程首页的职责。

三语 README 使用相同结构：

1. `# Learn Agent Harness`
2. 语言切换
3. 两段核心主张
4. 三门课程对照表
5. 按学习目标选课
6. Agency、Agent System、Harness、Framework 的概念定义
7. Provider-neutral 的最小 Agent Loop
8. 为什么需要三种学习视角
9. 仓库结构
10. 三门课程的独立快速开始
11. 语言与运行条件说明
12. 许可和相关项目

### 6.1 首屏内容

首屏必须在读者滚动很少的情况下回答三个问题：

- 这个仓库教什么？
- 为什么有三门课程？
- 我应该从哪一门开始？

根 README 不应先展示完整历史案例，再在数百行后才出现课程入口。

### 6.2 课程对照字段

三门课程使用统一字段介绍：

| 字段 | Learn Claude Code | Learn Pi Agent | Learn LangChain |
|---|---|---|---|
| 学习视角 | 从机制层重建成熟 Coding Agent Harness | 从小内核和扩展边界理解 Agent Runtime | 使用成熟框架 API 构建 Agent 应用 |
| 最终产物 | 递进式 Coding Agent Harness | 可分支、可扩展的 mini Pi | 带工具、记忆、检索和 RAG 的课程助教 |
| 技术栈 | Python | TypeScript | Python |
| 章节数 | 22 | 13 | 13 |
| 模型调用 | 真实 Anthropic API | 无真实模型调用 | 示例使用 OpenAI，测试离线 |
| 语言 | 英中日 | 英中日，源码溯源英中 | 中文 |
| 适合人群 | 想理解 Harness 机制的开发者 | 想理解 Runtime 架构的 TypeScript 开发者 | 有 Python 基础的 Agent 初学者 |

### 6.3 学习路径

根 README 不定义唯一的初级到高级顺序，而是按目标推荐：

- 第一次接触 LLM 应用：从 `learn-langchain` 开始。
- 想理解框架背后的 Harness 机制：从 `learn-claude-code` 开始。
- 想研究 Provider、Session、Extension 和 Runtime 边界：从 `learn-pi-agent` 开始。
- 想完整走一遍：`learn-langchain` -> `learn-claude-code` -> `learn-pi-agent`。

### 6.4 统一概念

根 README 使用以下定义，避免课程之间产生概念冲突：

- **Agency**：模型通过训练获得的感知、推理和行动能力。
- **Agent System / Agent Product**：模型与可操作环境结合后的完整系统。
- **Harness**：工具、知识、观察、行动接口、上下文管理和权限边界。
- **Framework**：构建 Harness 组件的一种工程工具，不是 Agency 的来源。

当前 README 中对 prompt chain、工作流图和编排库的绝对否定需要改为：

> 编排库、状态图和 prompt chain 可以是有效的 Harness 工具，用于连接模型、上下文、工具和执行环境；但它们本身不产生 Agency，也不能替代模型的判断能力。

### 6.5 从根 README 下沉的内容

以下内容移动到 `learn-claude-code/README*`：

- 为什么选择 Claude Code 作为教学标本。
- 22 节课程格言和完整章节表。
- 旧 12 节与新 22 节的版本说明和映射。
- Claude 课程的快速开始和学习路径图。
- Claude 课程目录树。
- Kode CLI、Kode SDK 和 claw0。
- Claude Web 的旧课程状态说明。

现有 README 中的两个已知错误同步修正：

- “新 20 章版本”改为“新 22 章版本”。
- 项目树中不存在的 `README.en.md` 改为实际文件名。

## 7. 三门课程的导入规则

### 7.1 Learn Claude Code

Claude 课程来自当前 Git 仓库的已跟踪内容，使用 Git 移动保留历史。

移动到 `learn-claude-code/`：

- `.env.example`
- `requirements.txt`
- `README.md`
- `README-zh.md`
- `README-ja.md`
- `agents/`
- `skills/`
- `tests/`
- `web/`，但不包含可重新生成的数据和复制资源
- `s01_*` 至 `s22_*`
- 旧 12 节课程文档 `docs/en`、`docs/zh` 和 `docs/ja`

保留在根目录：

- `LICENSE`
- 将 `origin/main` 中现有的 `CONTRIBUTING.md` 改写为三门课程通用贡献指南
- 重写后的 `.gitignore`
- 重建后的 `.github/workflows`
- 新的三语根 README

明确排除在最终树之外：

- `docs/superpowers/` 下所有规格和计划，包括本规格。
- 当前工作区中未跟踪的 context compact 计划、草图和中文中间稿。
- `web/src/data/generated/` 下的 JSON。
- `web/public/course-assets/` 下由抽取脚本复制的图片。

`web/src/data/generated/` 和 `web/public/course-assets/` 均由 `npm run extract` 从课程正文和章节图片重建。它们不再进入 Git，避免提交漂移的派生数据和重复图片。

Claude 课程 README 中所有“仓库根目录”表述改为“课程根目录”。首次运行说明必须明确：

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness/learn-claude-code
```

章节内已有的相对导航和图片链接保持不变。`web/` 与课程整体移动，因此基于 `web/..` 推导课程根的抽取逻辑不需要重写。

### 7.2 Learn Pi Agent

只导入以下内容：

- `README.md`
- `README.zh.md`
- `README.ja.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `s01_agent_loop/` 至 `s13_integrated_harness/`
- 章节 README、代码、测试、图片和源码溯源文档

明确排除：

- `node_modules/`
- `.DS_Store`
- `.claude/`
- `.superpowers/`
- `docs/superpowers/`
- `设计规范.md`
- 所有 `README.zh.md.bak`
- `reference/pi/`
- `reference/claw0/`
- 任何嵌套 `.git/`

课程 README 增加安装步骤：

```bash
cd learn-pi-agent
npm ci
npm run check
npm run session:s01
```

Node.js 要求在根 README 和课程 README 中都准确标记为 `>=25`。

当前 `package-lock.json` 的 tarball URL 使用 `registry.npmmirror.com`。导入时在不改变依赖版本和 integrity 的前提下，使用 `https://registry.npmjs.org` 重新生成 lockfile 元数据，然后分别在本地和 GitHub Actions 中验证 `npm ci`。

### 7.3 Learn LangChain

源目录 `learn-langchain-beginner` 导入后统一改名为 `learn-langchain`。

导入：

- `README.md`
- `CONTRIBUTING.md`
- `.env.example`
- 课程级 `.gitignore`，保持当前内容
- `pyproject.toml`
- `uv.lock`
- `scripts/`
- `shared/`
- `tests/`
- `s01_first_model/` 至 `s13_comprehensive_project/`

排除：

- `.venv/`
- `.mypy_cache/`
- `.pytest_cache/`
- `.ruff_cache/`
- `__pycache__/`
- `.references/`
- `.serena/`
- `.claude/`
- `.DS_Store`
- `cf-build-log.json`
- 子目录 `.github/workflows/`
- `deep-research-report.md`
- `docs/course-design-analysis.md`
- `docs/lesson-alignment-audit.md`
- `docs/source-alignment.md`
- 整个 `docs/` 目录

同步修改：

- `pyproject.toml` 的项目名从 `learn-langchain-beginner` 改为 `learn-langchain`。
- README 标题改为 `Learn LangChain：从 Model 到 Agent 与 RAG`。
- “本仓库”按语义改为“本课程”或“本课程目录”。
- 快速开始从 monorepo 根进入 `learn-langchain/`。
- 课程仍明确标记为中文课程和入门路径。
- README 不再把 `deep-research-report.md` 描述成公开课程依据，改为直接说明 13 节公开课程主线。
- README 删除本地 `.references/` 和 `docs/source-alignment.md` 入口，不保留设计期校准叙事。
- `scripts/check_lessons.py` 不再引用未发布的 `deep-research-report.md`，改为描述公开的课程文件契约。
- `pyproject.toml` 和课程 `.gitignore` 删除仅服务于 `.references/` 的内部排除规则。
- 修改项目名后运行 `uv lock` 重建锁文件；审阅结果时只接受本地项目名和必要元数据变化，不接受未说明的依赖版本升级。

## 8. 第三方参考源码与溯源

### 8.1 Pi

本地 `reference/pi` 实际指向：

- 仓库：`https://github.com/earendil-works/pi.git`
- 固定提交：`2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`
- 对应课程版本：`0.79.1`

课程 README 当前指向 `badlogic/pi-mono`，与本地参考源和包元数据不一致，合并时统一改为 `earendil-works/pi`。

所有 `pi-source*.md` 中的本地路径按以下规则转换：

```text
reference/pi/<file>
->
https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/<file>
```

目录链接使用同一提交下的 `/tree/` URL。课程不增加 submodule，也不增加自动拉取参考仓库的脚本。

`reference/claw0` 不导入，只在课程方法来源中保留固定提交链接：

- 仓库：`https://github.com/shareAI-lab/claw0`
- 提交：`0090e863bd90aaebc79d244223cc2acc7c284eaf`

### 8.2 LangChain

`.references/`、源码 clone、source alignment、研究报告和课程设计分析全部不导入。最终课程的公开事实来源只有课程 README、章节内容、`pyproject.toml`、`uv.lock` 和可运行测试。依赖版本由锁文件复现，不要求学习者了解设计期使用过的本地校准环境。

## 9. 忽略规则

根 `.gitignore` 以多语言 monorepo 为目标重写。

必须删除：

```gitignore
/learn-claude-code/
/learn-pi-agent/
```

必须覆盖：

```gitignore
.DS_Store
.claude/
.codex/
.agents/
.serena/
.superpowers/
docs/superpowers/
AGENTS.md
CLAUDE.md
**/__pycache__/
**/.pytest_cache/
**/.mypy_cache/
**/.ruff_cache/
**/.venv/
**/node_modules/
**/.next/
**/out/
**/.env
**/.env.*
!**/.env.example
*.bak
learn-pi-agent/reference/
learn-langchain/.references/
learn-claude-code/web/src/data/generated/
learn-claude-code/web/public/course-assets/
```

Claude 课程运行时产生的 `.memory/`、`.tasks/`、`.teams/`、`.mailboxes/`、`.worktrees/` 和调度状态继续忽略。

锁文件必须进入版本控制：

- `learn-claude-code/web/package-lock.json`
- `learn-pi-agent/package-lock.json`
- `learn-langchain/uv.lock`

## 10. CI 设计

GitHub 只执行仓库根 `.github/workflows/` 中的工作流，因此三个课程各有一个根级 workflow，另有一个仓库卫生 workflow。

初次合并不使用 workflow 级路径过滤。四个 workflow 在所有指向 `main` 的 PR 和所有 `main` push 上运行，避免被路径过滤跳过的 required check 长期停留在 Pending。路径优化不属于本次合并范围。

`origin/main` 现有的 `.github/workflows/sync-upstream.yml` 必须删除。该 workflow 会把 `shareAI-lab/learn-claude-code` 的整个根目录定时合入 monorepo 根，在目录迁移后会破坏仓库结构。后续 Claude 上游同步只能通过 `shareai` remote 做人工、路径感知的移植。

### 10.1 `claude-code.yml`

包含两个 job：

- Python：使用 `actions/setup-python` 配置 Python 3.11，安装 `learn-claude-code/requirements.txt` 和 Pytest，在课程目录运行 `python -m pytest tests -q`。
- Web：使用 `actions/setup-node` 配置 Node 20，npm cache path 指向 `learn-claude-code/web/package-lock.json`，在 `learn-claude-code/web` 运行 `npm ci`、`npm run extract`、`npx tsc --noEmit` 和 `npm run build`。显式 extract 保证未跟踪生成 JSON 时类型检查仍有输入。

### 10.2 `pi-agent.yml`

使用 `actions/setup-node` 配置 Node 25，npm cache path 指向 `learn-pi-agent/package-lock.json`，在 `learn-pi-agent` 运行：

```bash
npm ci
npm run check
```

### 10.3 `langchain.yml`

使用 `actions/setup-python` 配置 Python 3.11，并使用 `astral-sh/setup-uv` 安装 uv。在 `learn-langchain` 运行：

```bash
uv sync --locked --extra dev
uv run python scripts/check_lessons.py
uv run ruff check .
uv run mypy .
uv run pytest -q
```

### 10.4 `repository-hygiene.yml`

仓库卫生检查在所有目标为 `main` 的 PR 和 `main` push 上运行，并验证：

- tracked working tree 总字节不超过 `4,718,592` bytes，即 4.5 MiB。
- 任意单个 tracked 文件不超过 `1,048,576` bytes，即 1 MiB。
- 不存在 Git mode `160000` 的 submodule 或嵌套 gitlink。
- 不存在设计规格、实施计划、研究报告、本机 Agent 配置、缓存、虚拟环境、参考 clone、备份文件和 Web 生成目录。

禁止路径至少覆盖：

```text
docs/superpowers/
.claude/
.codex/
.agents/
.serena/
.superpowers/
learn-langchain/.references/
learn-pi-agent/reference/
node_modules/
.venv/
__pycache__/
web/src/data/generated/
web/public/course-assets/
deep-research-report.md
course-design-analysis.md
lesson-alignment-audit.md
cf-build-log.json
AGENTS.md
CLAUDE.md
*.bak
.DS_Store
```

四个 workflow 均在目标为 `main` 的 `pull_request` 和 `main` 分支的 `push` 上运行。分支保护可以把三门课程 job 和 repository hygiene job 设置为 required checks，因为它们不会因路径过滤而被整个跳过。

## 11. 路径和运行目录

三门课程都把自己的目录视为运行根目录。

根 README 的快速开始采用：

```bash
git clone https://github.com/Bill-Billion/learn-agent-harness.git
cd learn-agent-harness
```

然后从 monorepo 根选择一门课程。根 README 将三个入口分别放在对应课程段落中，不放进同一个可连续复制的代码块：

- Claude：`cd learn-claude-code`
- Pi：`cd learn-pi-agent`
- LangChain：`cd learn-langchain`

不能从 monorepo 根直接执行依赖 `Path.cwd()` 的 Claude 示例。Claude 的任务、记忆、团队、worktree 和 skill 查找均可能依赖当前工作目录。

链接策略：

- 仓库内导航优先使用相对链接。
- 只有 clone 命令、上游项目和固定源码引用使用绝对 URL。
- 根 README 不链接到本地 `.references` 或 `reference` 路径。
- Web Header 的 GitHub 链接改为新仓库，并指向 Claude 课程目录或新仓库首页。

## 12. 许可与归属

初次合并保留现有根 `LICENSE` 内容，不擅自改写 `shareAI Lab` 的版权声明。

`learn-pi-agent` 和 `learn-langchain` 当前均没有独立 LICENSE。将它们发布到根 MIT 仓库前，必须由用户明确确认：这两门课程是可由 Bill-Billion 以根 MIT 许可证发布的第一方内容。未获得确认时，迁移可以在本地审阅，但不得合入 `main`、执行仓库改名或公开发布。

本次合并不导入 Pi、LangChain 或 claw0 的源码仓库，因此不存在把第三方仓库许可证文件一并 vendoring 的需求。课程 README 和源码溯源文档保留清晰的上游项目链接、固定提交和版本信息。

若后续需要为 Bill-Billion 新增版权声明，应作为单独的许可变更审阅，不与结构迁移混在同一提交中。

## 13. Git 迁移策略

### 13.1 工作区

本规格和后续实施计划只在当前本地工作区提交用于审阅，不推送、不合入最终集成分支。实现分支只使用明确的远端课程提交：从 `origin/main` 创建，并合入 `origin/rewrite/lecture-style`。分析时该课程提交为 `c05ed94`；如果实施前远端课程内容继续更新，实施计划必须记录新的明确 SHA。

实现阶段创建干净 clone，并在新分支工作：

```text
工作目录：/Users/yanghaoran/Code/learn-agent-harness
分支：codex/learn-agent-harness-monorepo
```

不移动、不清理、不覆盖当前 `/Users/yanghaoran/Code/learn-claude-code` 工作区。

集成分支从 `origin/main` 创建，然后以一个显式 merge commit 合入 `origin/rewrite/lecture-style`。冲突逐文件解决：保留 `main` 独有的代码、CI 和贡献文档变更，同时保留 `rewrite/lecture-style` 的课程正文和三语同步结果；不使用全局 `ours` 或 `theirs` 覆盖。

完成这次预集成后，先运行现有 Claude 测试，再开始目录迁移。最终 PR 的 base 明确为 `main`。

干净 clone 只配置两个 remote：

- `origin`：迁移前指向 `Bill-Billion/learn-claude-code`，GitHub 改名后更新为 `Bill-Billion/learn-agent-harness`。
- `shareai`：指向 `shareAI-lab/learn-claude-code`，只用于追踪 Claude 课程历史来源。

当前与 `origin` 重复的 `upstream` remote 不复制到新工作区。

### 13.2 历史

- Claude 内容通过 Git move 保留文件历史。
- Pi 和 LangChain 当前不是 Git 仓库，以单次干净快照导入。
- 不复制任何 `.git` 目录。
- 不使用 subtree 或 submodule。

### 13.3 提交边界

预集成 merge commit 之后，实现分为四个可审阅提交：

1. `refactor: assemble learn-agent-harness monorepo`
   - 移动 Claude 课程。
   - 导入两门新课程的允许内容。
   - 重写根 `.gitignore`。

2. `docs: establish three-course harness learning paths`
   - 新建根三语 README。
   - 更新三个课程入口、名称和范围说明。
   - 修复 Claude 22 节和 README 文件名错误。

3. `docs: replace local source references with pinned links`
   - 转换 Pi 源码溯源。
   - 清理 LangChain README、配置和检查脚本中的设计期来源引用。
   - 删除所有对未发布本地 reference clone、研究报告和 source alignment 的错误承诺。

4. `ci: validate each course independently`
   - 建立三个课程 workflow 和一个 repository hygiene workflow。
   - 删除失效或重复的旧 workflow。

如果 Git 在大范围移动中没有自动识别 rename，不通过改写历史修复；保持内容一致并依赖 Git 的相似度检测即可。

## 14. GitHub 和部署切换

仓库改名是最后一步，不在本地结构验证之前执行。

顺序如下：

1. 将集成分支推送到 `Bill-Billion/learn-claude-code`。
2. 创建以 `main` 为 base 的 PR，等待三门课程和仓库卫生 CI 通过。
3. 完成最终内容审阅并合并 PR。
4. 在旧仓库名下从更新后的默认分支 `main` 做一次 smoke clone，确认默认首页已经是 monorepo。
5. 将 GitHub 仓库改名为 `Bill-Billion/learn-agent-harness`。
6. 同时更新本地 `origin` 的 fetch URL 和 push URL。
7. 保留 `shareai` remote 作为 Claude 课程历史来源，不把它当作 monorepo 上游；重复的 `upstream` remote 不保留。
8. 从新 URL 的默认分支再次做 smoke clone。
9. 更新 GitHub repository description、topics 和 homepage。
10. 更新 Vercel 的 Root Directory，使 Claude Web 指向移动后的目录。
11. 检查分支保护的 required status checks，替换失效的旧 job 名称。

GitHub 对旧仓库 URL 的重定向只能作为兼容措施，新 README 和 Web 不继续依赖旧地址。

## 15. 验证计划

### 15.1 仓库卫生

运行：

```bash
git diff --check
git status --short
git ls-files | rg '(^|/)(docs/superpowers|\.claude|\.codex|\.agents|\.serena|\.superpowers|node_modules|\.venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(/|$)|learn-pi-agent/reference/|learn-langchain/\.references/|web/src/data/generated/|web/public/course-assets/|deep-research-report\.md$|course-design-analysis\.md$|lesson-alignment-audit\.md$|source-alignment\.md$|cf-build-log\.json$|(^|/)(AGENTS|CLAUDE)\.md$|\.bak$|(^|/)\.DS_Store$'
git ls-files --stage | awk '$1 == "160000" { print }'
```

最后两条命令均预期无输出；第二条额外防止嵌套 Git 仓库被记录成 gitlink。

用 tracked 文件逐个计算体积：

```bash
python - <<'PY'
from pathlib import Path
import subprocess

paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
sizes = [(Path(path).stat().st_size, path) for path in paths if path]
total = sum(size for size, _ in sizes)
large = [(size, path) for size, path in sizes if size > 1_048_576]
print(f"tracked_files={len(sizes)} tracked_bytes={total} mib={total / 1_048_576:.3f}")
assert total <= 4_718_592, "tracked tree exceeds 4.5 MiB"
assert not large, f"tracked file exceeds 1 MiB: {large}"
PY
```

最终预期约 4.0 至 4.2 MiB；命令超过 4.5 MiB 或发现单文件超过 1 MiB即失败。

### 15.2 Claude 课程

从 `learn-claude-code/` 运行：

```bash
python -m pytest tests -q
```

从 `learn-claude-code/web/` 运行：

```bash
npm ci
npm run extract
npx tsc --noEmit
npm run build
```

### 15.3 Pi 课程

从 `learn-pi-agent/` 运行：

```bash
npm ci
npm run check
npm run session:s01
npm run session:s13
```

### 15.4 LangChain 课程

从 `learn-langchain/` 运行：

```bash
uv sync --locked --extra dev
uv run python scripts/check_lessons.py
uv run ruff check .
uv run mypy .
uv run pytest -q
```

离线测试不配置 API key。真实 OpenAI 示例只做文档命令检查，不在 CI 中调用。

### 15.5 内容和链接

全仓库搜索以下残留：

```text
learn-langchain-beginner
Bill-Billion/learn-claude-code
shareAI-lab/learn-claude-code 作为 clone 主入口
新 20 章
README.en.md
reference/pi/
.references/
docs/superpowers/
deep-research-report.md
course-design-analysis.md
lesson-alignment-audit.md
source-alignment.md
web/src/data/generated/
web/public/course-assets/
AGENTS.md
CLAUDE.md
```

允许存在的情况必须是历史说明或明确标注的上游来源，不允许作为当前运行路径。

检查三语根 README：

- 章节顺序一致。
- 三门课程字段一致。
- 课程语言状态一致。
- 链接分别指向正确语言入口。
- 不把 LangChain 课程描述成已有英日翻译。
- 不把 Pi 描述成真实模型课程。
- 不把 LangChain 离线测试描述成所有示例都不需要 API key。

### 15.6 干净 clone 验证

在所有本地检查通过后，从远端集成分支重新 clone 到临时目录，重复三个课程的验证命令。

这一步用于证明：

- 构建不依赖当前机器的隐藏文件。
- Pi 不依赖未发布的 `reference/pi`。
- LangChain 不依赖 `.references` 或现有 `.venv`。
- Claude Web 不依赖原根目录位置。

## 16. 验收标准

只有同时满足以下条件，合并才算完成：

1. 根目录品牌和三语 README 均为 Learn Agent Harness。
2. 三个课程目录名称和 README 链接正确。
3. `learn-langchain-beginner` 已完整改名为 `learn-langchain`。
4. Claude 课程 Git 历史仍可追踪。
5. 三门课程的安装和测试互不依赖。
6. 三门课程和 repository hygiene 四个 GitHub Actions 均通过。
7. 仓库中没有嵌套 Git 仓库、本地环境、缓存或参考 clone。
8. Pi 的公开源码溯源使用固定链接；LangChain 的依赖基线由 `uv.lock` 复现。
9. 根 README 不再与 LangChain 课程的存在发生概念冲突。
10. Claude Web 完成移动后的构建验证。
11. 从远端干净 clone 后仍能重复验证。
12. GitHub 仓库、remote、description、topics 和部署路径完成改名切换。
13. 用户已确认两门新增课程可以按根 MIT 许可证公开发布。
14. 最终 HEAD 不包含规格、计划、研究报告、模型工作说明、生成 JSON 或重复资源。
15. 最终 tracked working tree 约 4.0 至 4.2 MiB，且绝不超过 4.5 MiB。

## 17. 风险与回退

### 17.1 主要风险

- 同名本地忽略目录被误当作正式课程导入。
- Pi 的嵌套 `.git` 被提交成 embedded repository。
- LangChain 的 184 MB `.venv` 或缓存进入 Git。
- Web 生成 JSON 或复制图片继续被跟踪，造成内容漂移和约 1.70 MB 的无效体积。
- 本地规格、计划或 Agent 工作文件因设计阶段提交而进入最终集成分支。
- Claude 的运行目录变化导致状态文件写入错误位置。
- 根 README 保留过多 Claude 专属信息，仍像单课程仓库。
- 根 README 对工作流框架的表述与 LangChain 课程互相否定。
- Vercel 或分支保护仍引用旧路径和旧 job 名称。

### 17.2 回退策略

- 所有结构变更在独立分支和干净 clone 中完成。
- 当前 `rewrite/lecture-style` 工作区不做破坏性清理。
- GitHub 改名只在分支验证完成后执行。
- 改名前可以直接放弃集成分支，不影响现有仓库。
- 改名后若出现外部集成故障，可以将 GitHub 仓库名改回，代码提交不需要回滚。
- 每个导入阶段保持独立提交，可单独检查来源和删除意外文件。

## 18. 审阅检查点

实施前需要经过一次用户规格审阅。实施过程中设置三个检查点：

1. **结构检查点**：三个课程已进入目标目录，但尚未进行 GitHub 改名。
2. **内容检查点**：根三语 README、课程入口和源码溯源完成，所有本地测试通过。
3. **切换检查点**：远端集成分支和 GitHub Actions 通过，随后才执行仓库改名与部署设置更新。

本规格获批后，再单独生成逐文件、逐命令、逐提交的实施计划。规格批准不等于立即执行迁移。
