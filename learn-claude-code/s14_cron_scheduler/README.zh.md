# s14: Cron Scheduler — 按时间表生产工作

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s12 → s13 → `s14` → [s15](../s15_agent_teams/) → s16 → ... → s20
> *"按时间表生产工作, 调度与执行解耦"* — cron 调度, 持久化或会话级。
>
> **Harness 层**: 调度 — 独立线程判断时间, 队列传递触发。

---

s13 之后，Agent 干活不再卡壳，但每一件事仍然由你的一句话启动。"每天早上 9 点跑测试""每 30 分钟看一眼 CI"，这类活总不能雇个人定时来敲回车。

第一反应也许是把要求写给模型："记住，每天 9 点跑测试。"这句话暴露了一个此前没点破的事实：**模型只在被调用时存在。** 没有请求进来，它就是一堆静止的权重，上下文里写着"每天 9 点"，可到了 9 点，没有任何东西会醒来看一眼。时间感这个能力，模型根本没有地方长，它只能长在 harness 上。

harness 里怎么长？让主循环 `sleep` 到 9 点是不行的，那是把整个 Agent 冻住。答案和你的闹钟一样：一个独立的、一直醒着的小东西，只负责看表，到点了喊一嗓子。

![Cron Scheduler Overview](images/cron-scheduler-overview.svg)

---

## 注册：坏表达式挡在门口

任务用五段式 cron 表达式描述（分 时 日 月 星期），注册时立刻校验：

```python
@dataclass
class CronJob:
    id: str
    cron: str        # "0 9 * * *"
    prompt: str      # 触发时注入给 Agent 的消息
    recurring: bool  # True=周期性，False=一次性
    durable: bool    # True=落盘，跨重启存活

def schedule_job(cron, prompt, recurring=True, durable=True):
    err = validate_cron(cron)      # 先校验，坏表达式当场拒绝
    if err:
        return err
    job = CronJob(id=f"cron_{random.randint(0, 999999):06d}", ...)
    with cron_lock:
        scheduled_jobs[job.id] = job
    if durable:
        save_durable_jobs()        # 落盘到 .scheduled_tasks.json
```

校验为什么必须在注册时做？想象反面：`99 99 * * *` 混了进去，等到调度线程逐个匹配时才抛异常，而调度线程是全局唯一的，一个坏任务能把所有任务的闹钟一起炸哑。教学版双保险：注册时校验拦住绝大多数，调度循环里再给每个任务套 try/except，单个任务出错只打日志，线程不死。

---

## 匹配：每秒看一次表，但每分钟只响一次

调度线程每秒醒来，拿当前时间对每个任务的表达式做匹配：

```python
def cron_scheduler_loop():
    while True:
        time.sleep(1)
        now = datetime.now()
        minute_marker = now.strftime("%Y-%m-%d %H:%M")   # 注意：带日期
        with cron_lock:
            for job in list(scheduled_jobs.values()):
                try:
                    if cron_matches(job.cron, now):
                        if _last_fired.get(job.id) != minute_marker:
                            cron_queue.append(job)               # 触发：进队列
                            _last_fired[job.id] = minute_marker  # 本分钟内不再响
                        if not job.recurring:
                            scheduled_jobs.pop(job.id, None)     # 一次性任务用完即弃
                except Exception as e:
                    print(f"[cron error] {job.id}: {e}")         # 单个坏任务不杀线程
```

两个容易做错的细节都藏在 `minute_marker` 里。第一，每秒轮询意味着同一个匹配分钟会命中 60 次，任务却只该响一次，所以要记住"这个任务在这一分钟已经响过"。第二，标记必须带日期：如果只记 `09:00`，每天 9 点的任务第一天响过之后，第二天 9 点一看标记相同，就再也不响了。这类 bug 上线一天后才发作，最难查。

`cron_matches` 本身忠实还原了传统 cron 的一个怪癖：日期和星期两个字段**同时**有约束时，语义是"或"不是"与"。`0 9 13 * 5` 的意思是"13 号或周五的 9 点"，想表达"既是 13 号又是周五"，标准 cron 写不出来。教学版没有"修正"它，兼容怪癖也是兼容的一部分。

---

## 解耦：调度器只管扔进队列，不管执行

到点之后，调度线程做的唯一动作是把任务追加进 `cron_queue`，然后继续看表。它绝不自己去跑 agent turn。原因有两层：跑一轮 agent 可能要几分钟，调度线程被拖住，后面所有任务的触发都延误；而且此刻用户可能正在和 Agent 对话，两个轮次并发写同一份历史，消息交错，s01 的配对规矩当场崩。

闹钟只负责响，不负责把你拖下床。把你拖下床的是另一个角色：

```python
def queue_processor_loop():
    """队列有活、且 Agent 空闲时，自动开一轮。"""
    while True:
        time.sleep(0.2)
        if not has_cron_queue():
            continue
        if not agent_lock.acquire(blocking=False):   # 拿不到锁 = Agent 正忙，下次再试
            continue
        try:
            run_agent_turn_locked()                  # 自动开一轮 agent turn
        finally:
            agent_lock.release()
```

`agent_lock` 是整个结构的轴心：用户敲回车的路径和定时触发的路径抢同一把锁，同一时刻只可能有一轮 agent turn 在跑。定时任务永远不会打断你正在进行的对话，只会等你说完话的空档进来。

最后一环在 `agent_loop` 开头，把触发的任务作为 user 消息注入，还是那条"世界的声音"通道：

```python
fired = consume_cron_queue()
for job in fired:
    messages.append({"role": "user", "content": f"[Scheduled] {job.prompt}"})
```

四层各司其职：调度器（看表）→ 队列（缓冲）→ 队列处理器（找空闲时机）→ 消费者（注入执行）。每一层只做一件事，这就是"调度与执行解耦"的全部含义。

durable 任务落在 `.scheduled_tasks.json`，程序启动时重新加载，加载时再校验一遍（磁盘上的文件可能被手改坏），非法的跳过并打日志。

> 真实 Claude Code：注册上限 50 个任务，重复任务 7 天自动过期；触发时间带抖动——重复任务最多延后周期的 10%，防止全世界的"9 点整"任务在同一秒砸向 API（惊群）；cron 发起的请求还会被标成低优先级工作负载，容量紧张时给交互式用户让路。

---

## 相对 s13 的变更

| 组件 | 之前 (s13) | 之后 (s14) |
|------|-----------|-----------|
| 触发方式 | 用户输入 | +cron 表达式定时触发 |
| 新线程 | 后台执行线程 | +调度线程（1s 轮询）+ 队列处理线程 |
| 新工具 | — | `schedule_cron`, `list_crons`, `cancel_cron`（共 11 个） |
| 持久化 | `.tasks/` 任务 | +`.scheduled_tasks.json` durable 作业 |
| 并发控制 | `background_lock` | +`cron_lock`, `agent_lock`（用户轮与定时轮互斥） |

---

## 试一下

```sh
cd learn-claude-code
python s14_cron_scheduler/code.py
```

1. **看它自己动起来**：`Schedule a cron job that runs every minute: report the current time`。等到下一个整分钟，终端会在你没有敲任何字的情况下自己热闹起来：`[cron fire]` → `[queue processor] delivering scheduled work` → `[inject cron]`，然后 Agent 跑完一整轮汇报时间。这是全课程第一次，工作不由你的输入启动；
2. **坏表达式进不了门**：`Schedule a cron job with expression "99 99 * * *" that says hi`。注册被拒，`minute: Value 99 out of bounds [0-59]`，调度器毫发无伤；
3. **跨重启**：`q` 退出再重启，启动日志出现 `[cron] loaded 1 durable job(s)`，下一个整分钟它照响。看够了就 `Cancel that cron job`，顺手翻一眼 `.scheduled_tasks.json` 确认清空；
4. **正在对话时它不插嘴**：趁整分钟到来之前问 Agent 一个需要多轮工具的问题，观察 cron 触发后 `[queue processor]` 不会立刻交付，等你这轮结束才进来。那就是 `agent_lock` 在工作。

---

## 接下来

Agent 现在又能干又准时，但它仍然是单兵作战。一个真正的项目需要并行推进：前端、后端、测试各是一摊活。s06 的子 Agent 是串行的打下手，s13 的后台线程只会跑命令，都不是"几个 Agent 同时开工、各管一摊"。

s15 Agent Teams → 主 Agent 当 lead，随手拉起几个 teammate 各干各的，靠一套文件邮箱互通消息。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
