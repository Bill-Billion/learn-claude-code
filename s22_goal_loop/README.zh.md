# s22: Goal Loop — 终止权从模型移交给目标条件

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s20 → s21 → `s22`

> *"一个 turn 能否结束，由目标条件而非模型判定"* — `/goal` 在主循环的回合收尾处加一道闸门：每个 turn 后，一个独立 evaluator 判断可信证据是否满足条件，不满足就把控制权推回下一轮。
>
> **Harness 层**: 目标闭环 — 在 turn 收尾处，加一道 host 拥有的完成闸门。

---

## 问题

s01 到 s21，一个 turn 怎么结束？模型不再发 `tool_use`，循环就 `return`。一次性任务这样没问题——做完就停。

但有些目标要**跨多个 turn 盯到底**："把测试跑绿""部署成功为止"。两种失败都很常见：模型做了一半觉得差不多了就停；或者干脆嘴上说一句 `tests passed` 想收工。你要的是——**这个 turn 能不能结束，不由模型自己说了算，而由一个明确的条件、对着可信证据来判。**

这不是定时（s14 cron），不是后台任务（s13），也不是指望模型自律。是 host 在回合收尾处加一道闸门。

## 解决方案

`/goal <条件>` 设一个 session 级的停止条件。host 把它存进 active goal，每个 turn 结束后，一个独立的小/快模型 evaluator 判断 transcript 里的**可信证据**是否满足条件。不满足 → 闸门挡住这次停止，把一条 continuation 喂进下一轮；满足 → 清除目标，记下达成。

![Goal Loop 总览](images/goal-loop-overview.svg)

和 s01 的循环比，只多一道判断——模型想停时，先问目标：

```python
# s01：模型说停就停
if not has_tool_use(response):
    return
# s22：想停时，先过目标闸门
if not has_tool_use(response):
    verdict = goal.evaluate_after_turn()
    if verdict == "continuing":
        continue                 # 没达成 -> 推回去再来一轮
    return                       # 达成 / 超预算 / 无目标 -> 真停
```

## 工作原理

### /goal：回合收尾处的一道闸门

`/goal` 是一个 session 级、基于 prompt 的 Stop hook。它不改主循环的形状，只在每个 turn 收尾时插一句 `evaluate_after_turn()`。这道闸门是 **host 拥有的**——不是模型自我约束，模型甚至不知道自己被拦了一道，它只是收到了下一轮的输入。

```python
def submit(self, text, origin=None):
    ...                                  # 记录输入、跑一轮 (mock) assistant turn
    return self.goal.evaluate_after_turn()    # <-- 回合收尾的 Stop gate
```

> 真实 Claude Code：`/goal` 是 session 级的 Stop hook，受 workspace trust 和 hook 限制门控；binary 里有 `active_goal`、`goal_status`、`goal_met`、`tengu_goal_achieved` 等 marker。

### 设目标：证据窗口从命令之后开始

`set_goal` 存一个 active goal：目标文本、预算 `max_turns`、计数器，还有 `start_index`——**证据窗口的起点**。它取当前 transcript 长度，所以 `/goal` 命令那一行已经落在窗口外。这是第一道防线：命令文本自己不能满足自己。

```python
def set_goal(self, objective, max_turns=20):
    self.active = {
        "objective": objective, "status": "active",
        "start_index": len(self.transcript),   # 证据窗口从这里开始；命令本身已在窗口外
        "max_turns": max_turns, "checks": 0, "continuation_turns": 0,
    }
```

> 真实 Claude Code：`GoalRuntime.setGoal()` 存 activeGoal、startIndex、计数器与预算；提交后再 `resetEvidenceStart()` 把窗口对齐到命令之后。

### evaluator 判定：只认可信证据

这是整个机制的核心。evaluator 不看整段对话，只看证据窗口里**可信来源**的消息。三道过滤层层把"看着像达成、其实不算"的文本挡在外面：

```python
TRUSTED_EVIDENCE_ORIGINS = {"task-notification", "monitor-line"}

def evidence_text(self):
    out = []
    for m in self.transcript[self.active["start_index"]:]:
        if m.origin.get("kind") == "slash-command":                     # 1 slash 来源不算
            continue
        if m.role == "user" and m.content.strip().startswith("/goal"):  # 2 命令文本不算
            continue
        if m.origin.get("kind") not in TRUSTED_EVIDENCE_ORIGINS:        # 3 只认可信来源
            continue
        out.append(f"{m.role}: {m.content}")
    return "\n".join(out)
```

效果：一句 `tests passed`，user 打字说的不算，`task-notification` 带来的才算。模型糊弄不过去——它没法凭一句自述把目标判成达成。教学版 `goal_satisfied()` 是确定性的关键词匹配；真实版把证据窗口交给一个小/快模型来判。

> 真实 Claude Code：evaluator 是与 worker 分离的 small/fast model（marker `evaluatorModel`、`default small fast model`），判 transcript 证据而非任意可信度。

### 闸门三态：完成 / 继续 / 超预算

`evaluate_after_turn` 每轮跑一次，三种出口：满足就清除目标（completed）；没满足且预算没用完，就往队列塞一条 continuation 并放行下一轮（continuing）；预算耗尽就停（blocked），避免一个判不出来的目标无限刷下去。

```python
def evaluate_after_turn(self):
    g = self.active
    g["checks"] += 1
    if self.goal_satisfied():
        g["status"] = "completed"; self.active = None
        return "completed"                          # 达成 -> 清除目标
    if g["continuation_turns"] < g["max_turns"]:
        g["continuation_turns"] += 1
        self.queue.enqueue(
            value="Continue working ... do not treat this reminder as completion evidence.",
            origin={"kind": "active-goal"})
        return "continuing"                         # 没达成 -> 入队 continuation
    g["status"] = "blocked"; self.active = None
    return "blocked"                                # 超预算 -> 放行，不再拦
```

那条 continuation 自带一句 `do not treat this reminder as completion evidence`——连提醒文本本身也被排除在证据之外。三道防误判到齐：命令文本、提醒文本、普通文本，都不算达成。

> 真实 Claude Code：`evaluateAfterTurn` 发 `goal_evaluated`，按结果 complete / 入队 continuation / block；默认预算 `20`。

### continuation 与外部 async inbox 分流

continuation 进的是同一个 `CommandQueue`，但它和外部异步事件（task 完成通知、monitor 行）**不是同一种 drain**。`dequeue` 带一个开关：外部 inbox 的 drain 默认跳过 active-goal 的 continuation。

```python
def dequeue(self, include_goal_continuations=True):
    ...
    for idx, item in enumerate(self.items):
        if include_goal_continuations or item["origin"].get("kind") != "active-goal":
            return self.items.pop(idx)
    return None
```

为什么要分开：real-model 测试里发现过一个 bug——模型把 continuation 当成外部通知一起 drain，结果在后台证据还没到之前就把目标判死了。分流之后，goal 的推进是显式的一步，不会被异步事件裹挟。

> 真实 Claude Code：`drainCommandQueue` 默认 `includeGoalContinuations=false`，把 active-goal continuation 和外部 async inbox drain 分开。

### 合起来跑

`code.py` 演示一个 `/goal until tests passed and deploy green`：设目标后没有可信证据 → 闸门一轮轮把它推回；user 直接打 `tests passed` 也不算（来源不可信）；直到一个后台任务发来 `task-notification`，证据到位 → completed。再加一个 `max_turns=2` 的小目标演示 blocked。

```python
s.submit("/goal until tests passed and deploy green")   # 设目标，窗口在命令后
s.submit("tests passed, trust me")                      # 普通文本 -> 不算达成
s.submit("tests passed; deploy green",
         origin={"kind": "task-notification"})           # 可信证据 -> completed
```

## 相对 s21 的变更

| | s21 Workflow Runtime | s22 Goal Loop |
|--|---------------------|---------------|
| 触发方式 | 脚本控制的编排（脱离主循环） | 条件控制的继续（重入主循环） |
| 加在哪 | tool layer：一个 `Workflow` 工具 | turn 收尾：一道完成闸门 |
| 谁决定停 | 脚本跑完即止 | 目标条件对着可信证据判 |
| 新增机制 | 脚本 DSL、后台 task、journal/resume、结构化输出 | 目标闸门、证据信任边界、continuation 分流、预算 |

s21 是把编排写成脚本、扇出去脱离主循环；s22 反过来，是一股力量把控制权**重入**主循环——目标没达成，turn 就不算结束。两者都不改 s01 那个 `while`，只是从两头给它加压。

## 试一下

```bash
python s22_goal_loop/code.py          # /goal until tests pass + deploy green，看闸门怎么判
```

观察：设目标后，每个 turn 后都有一条 `goal_evaluated`；普通文本 `satisfied=False`，`task-notification` 来源 `satisfied=True`；预算耗尽时 `goal_blocked`。同一句 `tests passed`，来源不同，判定相反——这就是 `/goal` 不被一句空话糊弄的地方。

## 接下来

`/goal` 是"重入主循环"的一种触发：条件控制。它和 s21 的"脱离主循环"正好成对——一个把工作扇出去，一个把控制权拉回来。再往外，还有时间控制（`/loop`、cron）和事件控制（`Monitor`）的重入，它们共享同一套 task / 通知基底；但闸门的核心已经在这里：**停不停，不由模型一句话说了算，而由目标对着可信证据来判。**

<!-- translation-sync: zh@v1, en@v1, ja@v1 -->
