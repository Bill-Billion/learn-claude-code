# s12: Task System — 目标太大，拆成小任务

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s10 → s11 → `s12` → [s13](../s13_background_tasks/) → s14 → ... → s20

> *"大目标拆成小任务, 排好序, 持久化"* — 文件持久化的任务图, 多 agent 协作的基础。
>
> **Harness 层**: 任务 — 持久化的目标, 可恢复的进度。

---

给 Agent 一个项目级的活：搭数据库、写 API、加测试。它用 s05 的 TodoWrite 列了张清单，然后按顺序开工：写 API 写到一半发现表还没建，回头补表；补完表加测试，发现 API 的接口签名又变了。

问题不在清单列得不好，在清单这个数据结构本身：平铺的列表表达不了"先有 schema 才能写 API"。任务之间的关系是图，不是序列。盖房子的工序表上，"上梁"后面必须拴着"先立柱"，光把它排在第三行是不够的。

还有一个更朴素的问题：s05 的清单住在进程内存里，`q` 一按就蒸发。项目级的活干到一半下班，明天的 Agent 应该能接着干。

![Task System Overview](images/task-system-overview.svg)

---

## TodoWrite 缺的三样东西

| | TodoWrite (s05) | Task System (s12) |
|---|---|---|
| 定位 | 当前任务的执行清单 | 可恢复的任务系统 |
| 存储 | 进程内存 | `.tasks/{id}.json` 文件 |
| 依赖 | 无 | `blockedBy` 依赖图 |
| 生命周期 | 当前会话 | 跨会话保留 |
| 归属 | 无 | `owner` 字段 + 认领机制 |

一句话分工：**清单管步骤，任务系统管协作。** 依赖让任务有了先后约束，持久化让进度扛得住重启，归属让"谁在干什么"有了答案。第三样现在看着多余（只有一个 Agent），s15 多 Agent 上场时它就是防止两个人抢同一个活的关键。

本章教学代码为聚焦任务系统，退回了基础循环（s11 的错误恢复未带入）。这不是取舍冲突：任务 CRUD 和错误恢复本来就是两个独立的层，真实系统里自然叠加。

---

## 存储：一个任务一个 JSON 文件

```python
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str          # pending | in_progress | completed
    owner: str | None    # 谁认领了它（多 Agent 场景）
    blockedBy: list[str] # 上游依赖的任务 ID

def save_task(task: Task):
    (TASKS_DIR / f"{task.id}.json").write_text(json.dumps(asdict(task), indent=2))
```

为什么一个任务一个文件，而不是一个大 JSON 存全部？为并发留的地基：将来多个 Agent 同时干活，各自更新各自认领的任务，改的是不同文件，冲突面最小。这个决定的分量，要到 s15 才完全显出来。

创建任务时声明依赖：

```python
def create_task(subject, description="", blockedBy=None) -> Task:
    task = Task(id=f"task_{int(time.time())}_{random.randint(0, 9999):04d}",
                subject=subject, description=description,
                status="pending", owner=None, blockedBy=blockedBy or [])
    save_task(task)
    return task
```

---

## 依赖检查：上游全部完成才能开工

```python
def can_start(task_id: str) -> bool:
    task = load_task(task_id)
    for dep_id in task.blockedBy:
        if not _task_path(dep_id).exists():
            return False          # 依赖不存在，视为被阻塞
        if load_task(dep_id).status != "completed":
            return False
    return True
```

注意"依赖不存在"这个分支。模型是会写错 ID 的（s05 讲过：工具参数来自模型，不可全信）。写错的 ID 如果直接 `load_task` 会崩，静默放行则更糟——依赖检查形同虚设。视为被阻塞是最稳的防御：任务动不了，但模型会在"Blocked by"的报错里看到那个怪 ID，自己纠正。

---

## 认领与完成：两个动作，三个状态

```
pending ──claim──→ in_progress ──complete──→ completed
```

```python
def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "pending":
        return f"Task {task_id} is {task.status}, cannot claim"   # 已被认领或已完成
    if not can_start(task_id):
        return f"Blocked by: {...}"                               # 上游没完
    task.owner = owner
    task.status = "in_progress"
    save_task(task)
```

认领被拒的两种情况直接回给模型当 `tool_result`：状态不对，或者上游未完。模型收到"Blocked by: [task_xxx]"就知道该先去干哪个，调度逻辑不用写在 harness 里，报错信息本身就在引导。

完成任务时多做一件事，扫一遍全部任务，把刚被解锁的播报出来：

```python
def complete_task(task_id: str) -> str:
    task = load_task(task_id)
    if task.status != "in_progress":
        return f"Task {task_id} is {task.status}, cannot complete"
    task.status = "completed"
    save_task(task)
    unblocked = [t.subject for t in list_tasks()
                 if t.status == "pending" and t.blockedBy and can_start(t.id)]
    ...   # "Unblocked: create API endpoints, write docs"
```

这一句播报是图结构的回报：完成 schema 的瞬间，模型立刻知道 endpoints 和 docs 都能动了，不用自己反复轮询。

---

## 教学版刻意留下的两个洞

**没有环检测。** 两个任务互相 `blockedBy`，`can_start` 对谁都返回 False，谁也认领不了，这就是死锁。教学版不检测，正好留给你在实验里亲手造一个（见下）。生产系统必须在创建依赖时验证无环。

**没有 release 回退。** 状态机里没有 `in_progress → pending` 这条边。认领了任务的 Agent 如果进程崩了，任务就永远卡在 `in_progress`，谁也接不了手，只能手动删 JSON。真实的 Claude Code 在 teammate 终止时会把它名下的任务清除 owner、重置回 `pending`，让别人重新认领。

> 真实 Claude Code：`claimTask` 用文件锁防竞争（锁内重读任务防 TOCTOU，检查 already_claimed / blocked 后才设 owner），ID 用递增整数加 `.highwatermark` 文件保证删除后不重用，依赖关系由 `TaskUpdate` 的 `addBlocks/addBlockedBy` 维护而非创建时声明。教学版的五个函数对应它的四个工具，结构同源。

---

## 相对 s11 的变更

| 组件 | 之前 (s11) | 之后 (s12) |
|------|-----------|-----------|
| 任务管理 | 无 | `Task` dataclass + 5 个工具 |
| 存储 | 无持久化 | `.tasks/{id}.json` 跨会话 |
| 依赖 | 无 | `blockedBy` 图 + `can_start` 检查 |
| 工具 | bash, read_file, write_file (3) | +create_task, list_tasks, get_task, claim_task, complete_task (8) |
| 生命周期 | — | pending → in_progress → completed（无 release 回退） |

---

## 试一下

```sh
cd learn-claude-code
python s12_task_system/code.py
```

1. `Create tasks: setup database schema, create API endpoints (depends on schema), write tests (depends on endpoints), write docs (depends on schema)`：翻开 `.tasks/` 目录，四个 JSON 文件躺在那里，`blockedBy` 字段如实记录着依赖；
2. `Claim and complete the first unblocked task`：完成 schema 时看 `[unblocked]` 播报，endpoints 和 docs 同时解锁；
3. 按 `q` 退出，**重新运行**，输入 `List all tasks`：清单原样恢复，做完的还是做完的。这是 s05 的内存清单做不到的事；
4. **亲手造一个死锁**：`Create task A blocked by task B, and task B blocked by task A. Then try to claim either one.`：两边都返回 `Blocked by`，谁也动不了。这就是没有环检测的代价，记住这个手感，将来设计任务系统时你会想起它。

---

## 接下来

任务图有了，但每个任务还是主 Agent 亲自跑、跑完才能干下一件。有些活天生就慢：全量测试十分钟，构建部署半小时。让一个按 token 计费的循环干等一个慢命令，钱和时间都烧在等待上。

s13 Background Tasks → 慢操作放后台跑，Agent 继续干别的，跑完了再回来收结果。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
