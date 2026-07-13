# s17: Autonomous Agents — Do Not Wait for the Lead; Claim Work from the Board

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s15 → s16 → `s17` → [s18](../s18_worktree_isolation/) → s19 → s20

> *"Do not wait for the lead to assign work; claim it from the board when idle"* — Poll while idle and claim available tasks.
>
> **Harness layer**: Autonomy — teammates self-organize without assignments from the lead.

---

The team gained rules in s16, but work is still assigned by name: "Alice does this, Bob does that." If the board contains ten tasks, the lead must call ten names. As the team grows, every lead turn is spent dispatching, and every turn is a real API call that costs money. The timing is also rigid: while the lead reviews a plan, teammates who have finished can only wait even though untouched tasks remain on the board.

Mature teams do not work that way. The task board is public, and whoever is free picks something up. This chapter reverses assignment from push to pull: **tasks are no longer assigned; they are claimed.**

The seed planted in s12 grows here. The `owner` field in each task file and the ownership check in `claim_task` looked unnecessary then; now they form the foundation that keeps several agents from fighting over the same work.

![Autonomous Agents Overview](images/autonomous-agents-overview.svg)

---

## Lifecycle: WORK Sprints, IDLE Patrols, and Leaving When There Is Nothing to Do

Across three chapters, a teammate's lifecycle has kept evolving. In s15 it left after ten rounds. In s16 it waited for instructions after finishing. In s17 it looks for the next job itself. The code is a two-state loop:

```python
while True:
    # WORK: one sprint (at most 10 LLM rounds) on the current job
    for _ in range(10):
        ...  # Check mail, call the model, execute tools

    # IDLE: patrol every 5 seconds; leave after 60 seconds without work
    idle_result = idle_poll(name, messages, name, role)
    if idle_result in ("shutdown", "timeout"):
        break
```

Patrol priority is explicit: the mailbox comes before the task board.

```python
def idle_poll(agent_name, messages, name, role) -> str:
    for _ in range(IDLE_TIMEOUT // IDLE_POLL_INTERVAL):   # 60s / 5s = 12 checks
        time.sleep(IDLE_POLL_INTERVAL)

        inbox = BUS.read_inbox(agent_name)
        if inbox:
            ...                      # shutdown_request → acknowledge and leave
            return "work"            # Ordinary message → inject it and return to work

        unclaimed = scan_unclaimed_tasks()
        if unclaimed:
            result = claim_task(unclaimed[0]["id"], agent_name)
            if "Claimed" in result:  # It counts only after a successful claim
                return "work"
    return "timeout"                 # Nothing for 60 seconds; leave voluntarily
```

The `timeout` branch deserves a pause: an employee with no work goes home. This is not merely convenient; it saves money. An idle polling thread may not call the model, but if it never exits, the process accumulates a collection of dead-weight teammates. Sixty seconds is a teaching parameter. A production system would use a longer window or notify the lead and let it decide whether the teammate stays.

---

## Competing for Work: First Come, First Served; Losers Keep Patrolling

The board scan selects only work that can actually begin, requiring all three conditions:

```python
def scan_unclaimed_tasks() -> list[dict]:
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        if (task.get("status") == "pending"      # Nobody has started it
                and not task.get("owner")        # It has no owner
                and can_start(task["id"])):      # Every dependency is complete (the s12 check)
            unclaimed.append(task)
    return unclaimed
```

What happens when two teammates patrol at the same moment and see the same task? The answer is in the return-value check around `claim_task`. The ownership validation written in s12 now matters: the first writer changes the state to `in_progress`; the later call receives `"Task xxx is in_progress, cannot claim"`. A teammate therefore must verify the result after claiming. Only `"Claimed" in result` means success. A loser logs `[idle] claim failed`, continues patrolling, and looks for other work on the next pass.

The honest boundary is unchanged: the teaching version has no file lock, so a window remains in which two threads read `pending` in the same millisecond and both write. The real system re-reads and validates inside a file lock, as discussed in s12. The teaching version accepts that small race to keep the "optimistic claim + retry on failure" pattern directly visible.

---

## Reinjecting Identity: Long-Runners Forget Who They Are

A teammate uses the `messages[-20:]` sliding window from s15. That is fine for a short-lived teammate, but an autonomous teammate is a distance runner. As it claims task after task and the window moves forward, the original sentence "you are Alice, a poet" eventually falls out. A teammate that loses its identity may answer irrelevant questions or even decide it is the lead and start directing others.

At the beginning of each outer-loop iteration, the harness therefore checks whether the message list is short, which means it is new or has recently been trimmed, and restores the identity:

```python
if len(messages) <= 3:
    messages.insert(0, {"role": "user",
        "content": f"<identity>You are '{name}', role: {role}. "
                   f"Continue your work.</identity>"})
```

This shares the same nerve as preserving five categories in s08's summary and keeping s09 memory alive through compaction: **context is lost over time, so anything that must survive needs an owner responsible for putting it back.** Identity is the most important item to preserve in a multi-agent system.

> In the real Claude Code, an idle teammate does not leave immediately. It sends the lead an `idle_notification`, and the lead or a timeout policy decides whether it stays. Claims use file locks to prevent races. The teaching version's "leave after 60 seconds" condenses that decision into one constant.

---

## Changes from s16

| Component | Before (s16) | After (s17) |
|------|-----------|-----------|
| Work assignment | Lead assigns by name | Teammates scan and claim from the board (pull model) |
| Teammate lifecycle | WORK → standby → externally dismissed | WORK → IDLE patrol → auto-claim / leave on timeout |
| Teammate tools | 5 | 8 (+`list_tasks`, `claim_task`, `complete_task`) |
| New functions | — | `scan_unclaimed_tasks`, `idle_poll` |
| Identity maintenance | None | Reinject `<identity>` when the message list becomes short |

---

## Try It

```sh
cd learn-claude-code
python s17_autonomous_agents/code.py
```

1. **A pure pull pipeline**: `Create three tasks: write a haiku to a.md, write a limerick to b.md, write a couplet to c.md. Then spawn two teammates 'w1' and 'w2', both poets, with the prompt "Check the task board and work autonomously."` The lead never assigns a single task. Watch `[idle] w1 auto-claimed` and `[idle] w2 auto-claimed` alternate as the three tasks are divided between them; the faster teammate does more.
2. **A failed claim in the open**: during experiment 1, you will probably see `[idle] claim failed: Task ... is in_progress`. Both teammates noticed the same task, but the loser neither crashed nor duplicated the work; it logged the failure and kept patrolling. That one line is the value of s12's ownership check.
3. **Leaving on their own**: after all three tasks complete, create nothing else and wait 60 seconds. `[idle] w1 timeout (60s)` appears, followed by `[teammate] w1 finished`. Employees with no work leave instead of leaving zombie threads behind.

---

## Next

The teammates are autonomous, and a new problem appears. Two teammates may claim separate tasks that both modify the same file. One finishes writing, and the other immediately overwrites it. The tasks are isolated; the filesystem is not. s06 warned about this, and now it is a real problem.

s18 Worktree Isolation → Give each task its own workspace: separate git worktrees, separate changes, and a merge when the work is done.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
