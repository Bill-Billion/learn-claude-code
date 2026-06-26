# s21: Workflow Runtime — 模型决定单步，脚本决定编排

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s19 → s20 → `s21`

> *"一次 tool_use，后台跑完一整套编排"* — `Workflow` 工具启动一个确定性、可恢复的脚本运行时，扇出一群子 agent。
>
> **Harness 层**: 编排 — 在单 agent 循环之上，加一层确定性的多 agent 脚本运行时。

---

## 问题

s01 到 s20，循环是模型驱动、单步的：每一轮模型挑一个工具，结果塞回 `messages[]`，再来一轮。开放式任务这样最好——下一步做什么，让模型看着上下文临场决定。

但有些活儿需要**确定性地编排一群 agent**。比如审一个大改动：十个维度并行找问题 → 每条发现各自派一个对抗性验证 → 汇总去重 → 按严重度排序。这种编排的形状是固定的，你想要的是：

- **并行**，不是一个个串着等；
- **确定**，同样的输入跑出同样的结构；
- **可恢复**，跑到一半断了，已经做完的部分别重来。

让模型在主循环里一步步驱动这套，又慢、又不确定、断了还得从头。这时候你想要的不是"再聊一轮"，而是**把编排写成一段代码**。

## 解决方案

Claude Code 在工具池里放一个 `Workflow` 工具。你（或者模型在 `ultracode` 触发下）给它一段**脚本**，脚本用 `agent() / parallel() / pipeline() / phase()` 这几个原语，把编排写成确定性的代码。

主循环只看到一次 `tool_use`，并**立即**拿到 `async_launched`——真正的执行在一个**后台运行时**里推进，上报进度、落盘 journal。脚本里的中间结果存在变量里，不进对话。`resumeFromRunId` 能让没改过的 `agent()` 命中 journal 缓存，断点续跑。

![Workflow Runtime 总览](images/workflow-runtime-overview.svg)

计划是代码，不是一个聊天轮次：

```python
SAMPLE_META = {"name": "review-changes", "description": "...", "phases": ["Review", "Verify"]}

async def sample_workflow(ctx, args):
    ctx.phase("Review")
    results = await ctx.pipeline(DIMENSIONS, audit, verify)   # 每个维度独立走 审计 → 验证
    confirmed = [f for r in results if r for f in r["confirmed"]]
    ctx.log(f"confirmed {len(confirmed)} real finding(s)")
    return {"confirmed": confirmed}
```

## 工作原理

### Workflow 工具：后台启动，主循环只见一次 tool_use

`Workflow`（别名 `RunWorkflow`）在主 agent 的工具池里。一个触发到来——显式的"跑/建 workflow"、一个保存好的 `/命令`、或 `ultracode` 高强度路径——模型就发出一个 `Workflow(...)` 的 `tool_use`。`WorkflowTool.call` 解析入参、校验 meta、过权限、注册一个 `local_workflow` 任务，然后**立即返回** `async_launched`。主循环不阻塞，继续往下；workflow 在后台跑。

```python
class WorkflowTool:
    async def call(self, meta, script_fn, args=None, resume_from_run_id=None):
        validate_meta(meta)
        check_permission(meta)
        run_id = resume_from_run_id or create_run_id(meta)
        task = LocalWorkflowTask(create_task_id(run_id), run_id, meta)
        task.event("async_launched", runId=run_id, taskId=task.task_id)   # 立即返回
        ...                                                                # 其余在后台
```

> 真实 Claude Code：工具立刻返回 `{status:'async_launched', taskId, taskType:'local_workflow', runId, summary, transcriptDir, scriptPath}`，后台任务稍后完成。

### 脚本与 meta：第一条语句

脚本的**第一条语句**必须是 `export const meta = { name, description, phases }`，而且是个纯字面量——不能有变量、函数调用、拼接。运行时在执行任何东西之前先解析它：`name`/`description` 驱动任务和 UI，`phases` 给进度分组命名。坏输入直接 `WorkflowInputError`。

```python
def validate_meta(meta):
    if not meta.get("name") or not meta.get("description"):
        raise WorkflowInputError("meta requires `name` and `description`")
    if "phases" in meta and not isinstance(meta["phases"], list):
        raise WorkflowInputError("meta.phases must be a list")
    return meta
```

> 真实 Claude Code：`parseWorkflowScript` 强制 meta 必须是第一条语句且是纯字面量；教学版直接收一个 dict。

### 编排原语：agent / parallel / pipeline / phase / log / workflow

脚本跑在一个上下文里，里面有用的全局量**只有**这几个编排原语。脚本本身不直接读写文件、不跑 shell——真正的代码库读写由**子 agent**通过它们自己的工具权限完成。原语是 `ExecutionState` 上的方法：

| 原语 | 作用 |
|------|------|
| `agent(prompt, {schema, label, phase})` | 扇出一个子 agent |
| `parallel(thunks)` | **屏障**：并发跑完全部、一起等回来 |
| `pipeline(items, *stages)` | 逐项分阶段、**无屏障** |
| `phase(title)` | 进度分组（upsert） |
| `log(message)` | 进度行 |
| `workflow(name, args)` | 嵌套子工作流（仅一层） |

`pipeline` 是默认选择——每个 item 独立穿过所有 stage，item A 在 stage 3 时 item B 可能还在 stage 1；只有真需要"拿到全部上一阶段结果"时才用 `parallel` 这个屏障。

```python
async def pipeline(self, items, *stages):
    async def run_item(item, idx):
        value = item
        for stage in stages:                       # 每个 item 独立走完所有 stage
            value = await stage(value, item, idx)
        return value
    return await asyncio.gather(*[run_item(it, i) for i, it in enumerate(items)])
```

> 真实 Claude Code：同名原语由 VM 注入脚本上下文；还有 `args`、`budget`（`budget.total/spent/remaining`）、agent 数上限（1000）、并发信号量。

### 结构化输出：agent({schema}) + StructuredOutput

`agent({schema})` 强制子 agent 返回一个匹配 schema 的 JSON 对象（通过一次 `StructuredOutput` 调用），运行时按 schema 校验、不匹配就重试一次。这样下游代码消费的是**对象**，不是要再解析的散文。

```python
result = self.runner.run(prompt, schema, label)
if schema is not None:
    ok, err = SimpleJsonSchema(schema).validate(result)
    if not ok:                                       # 一次 nudge 重试，再不行就报错
        result = self.runner.run(prompt + "\n\nReturn valid JSON.", schema, label)
        ok, err = SimpleJsonSchema(schema).validate(result)
        if not ok:
            raise WorkflowInputError(f"agent({{schema}}) invalid output: {err}")
```

> 真实 Claude Code：`SimpleJsonSchema` + `StructuredOutput` 工具 + schema 重试。

### 背景任务与进度事件

`LocalWorkflowTask` 持有 status/usage，并向外发出一条 SDK 风格的事件流：`task_started` → 一串 `task_progress`（装着 `workflow_phase` / `workflow_agent` / `workflow_log` 批次）→ 最后一个 `task_notification`（completed / failed / stopped，带 output 文件、token 数、工具调用数、耗时）。主会话把这些当事件看；只有最终的 notification 会重新进入循环。

```python
class LocalWorkflowTask:
    def progress_event(self, ptype, **data):         # workflow_phase / workflow_agent / workflow_log
        self.progress.append({"type": ptype, **data})
        print(f"  progress   {ptype} ...")
```

> 真实 Claude Code：进度折叠进任务状态，作为 `task_progress.workflow_progress` 发给 UI/SDK。

### 存储：快照 + journal

跑完写五样东西，都落在 `~/.claude/projects/<project>/<session>/` 下：快照 `<runId>.json`、输出 `<runId>.output.json`、journal `<runId>.journal.jsonl`、脚本 `scripts/<runId>.js`、子 agent transcript `subagents/workflows/<runId>/`。保存好的 workflow 放 `.claude/workflows/`（项目）或 `~/.claude/workflows/`（用户）。

journal 是 resume 的关键——它逐条记下每个 `agent()` 的结果：

```python
class WorkflowJournal:
    def record(self, key, value):
        self._f.write(json.dumps({"key": key, "value": value}) + "\n")
        self._f.flush()
        self.cache[key] = value
```

### resume：从 runId 复用缓存

`Workflow({scriptPath, resumeFromRunId, args})` 会**重跑脚本**，但每个 `agent()` 会算一个**确定性的语义 key**：key 在 journal 里就直接返回缓存结果（不重跑），没改过的全部命中；改过的那个及它之后的才真跑。

关键在于 key **不能依赖并发顺序**——`parallel`/`pipeline` 里 agent 的完成次序是不定的，所以 key 由调用内容（kind、label、prompt、schema）的稳定哈希算出，而不是一个会竞争的计数器。

```python
def key(self, kind, label, prompt, schema):
    basis = f"{kind}|{label}|{prompt}|{json.dumps(schema, sort_keys=True)}"
    return f"{kind}-{_stable_hash(basis) % 10**10:010d}"

# agent() 里：
cached = self.journal.cached(key)
if cached is not MISS:
    self.task.progress_event("workflow_agent", label=label, status="cached")
    return cached
```

> 真实 Claude Code：同样是"确定性语义 key + journal 缓存"；同会话内 resume 完成过的 `agent()` 返回缓存、之后的实跑。

### 确定性：可复现是前提

resume 要成立，脚本就得可复现。所以运行时把 `Date.now()`、无参 `new Date()`、`Math.random()` 从脚本上下文里去掉，也不给 Node API。同一份脚本 + 同样的 args → 同样的 key → 100% 缓存命中。教学版用稳定哈希算 key 来达到同样的效果（真实版是把整段 JS 脚本跑在去掉这些非确定源的沙箱 VM 里）。

### 合起来跑

示例 workflow `review-changes`：`pipeline` 把每个审查维度独立地走"审计 → 验证"——审计用一个带 schema 的 `agent()` 找问题，验证用 `parallel()` 给每条发现各派一个对抗性验证子 agent，最后只留 `isReal` 的、按严重度排序。

```python
async def sample_workflow(ctx, args):
    ctx.phase("Review")

    async def audit(_v, dimension, _i):
        out = await ctx.agent(f"Review the changed files for {dimension} issues.",
                              schema=FINDINGS_SCHEMA, label=f"audit:{dimension}", phase="Review")
        return {"dimension": dimension, "findings": out["findings"]}

    async def verify(audited, dimension, _i):
        ctx.phase("Verify")
        verdicts = await ctx.parallel([                       # 每条发现独立对抗性验证
            (lambda f=f: ctx.agent(f"Adversarially verify ... {f['title']}",
                                   schema=VERDICT_SCHEMA, label=f"verify:{dimension}:{f['title']}"))
            for f in audited["findings"]])
        return {"dimension": dimension,
                "confirmed": [f for f, v in zip(audited["findings"], verdicts) if v and v["isReal"]]}

    results = await ctx.pipeline(DIMENSIONS, audit, verify)
    ...
```

## 相对 s20 的变更

| | s20 综合体 | s21 Workflow Runtime |
|--|-----------|---------------------|
| 循环 | 单个、模型驱动 | 主循环不变；之上加一层确定性编排 |
| 谁决定下一步 | 模型逐轮决定 | 脚本预先写定编排 |
| 多 agent | s06 子 agent，一次性扇出 | 脚本化、可复现、可恢复的批量编排 |
| 新增机制 | — | 脚本 DSL、后台 task、进度事件、journal/resume、结构化输出、确定性 VM |

s21 不替换主循环——它在 tool layer 暴露 `Workflow`，背后启动一个 `local_workflow` 运行时：**一个 workflow 确定性地驱动 N 个 agent 循环**。s06 的子 agent 是模型临场扇出一次；s21 是把编排写成可重放的脚本。

## 试一下

```bash
python s21_workflow_runtime/code.py          # 启动 review-changes，看事件流
python s21_workflow_runtime/code.py resume   # 用上次 runId 续跑，每个 agent() 命中 journal 缓存
```

观察：一次 launch → `async_launched` → 后台 `workflow_phase` / `workflow_agent` 进度推进 → `task_notification`；结果留在 task 上。`resume` 时 `agents=0 tokens=0`（全部缓存命中），结果一字不差。

## 接下来

编排是 agent 能力之上的又一层：**主循环管单步，脚本管整支队伍**。把工作写成确定性、可恢复的脚本，模型就从"逐轮驱动者"变成了"被脚本调度的执行单元"——同一个 `agent()`，既能在主循环里被模型临场调用，也能在 workflow 里被脚本批量编排。

接下来：[s22 Goal Loop](../s22_goal_loop/) — 编排把工作扇出去、脱离主循环；下一章反过来，一个目标把控制权重入主循环，没达成就不让 turn 结束。

<!-- translation-sync: zh@v1, en@v1, ja@v1 -->
