# s18: Worktree Isolation — Work Separately without Interference

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s16 → s17 → `s18` → [s19](../s19_mcp_plugin/) → s20

> *"Separate directories, separate work, no interference"* — Tasks manage goals; worktrees manage directories; IDs bind them together.
>
> **Harness layer**: Isolation — separate directories for parallel execution.

---

A sentence in s06 sounded like a disclaimer at the time: "the conversation context is isolated; the filesystem is not." By s17, it has become a real explosive.

Alice and Bob claim separate tasks but work in the same directory. Alice's task changes `config.py`, and Bob's does too. The later write overwrites the earlier one. A subtler version is that both read the old file, modify it independently, and write back a hybrid that neither intended. There is no clean rollback either: both sets of changes are tangled together in `git diff`, with no clear ownership for each line.

s15 through s17 answered "who does what" with the task board and "how do they communicate" with mailboxes. They never answered "where do they work?"

![Worktree Overview](images/worktree-overview.svg)

---

## Why Locks Are Not the Answer

The first instinct is to add locks. Lock the entire repository? Concurrency collapses back into serial execution, erasing the reason to form a team in s15. Lock individual files? First you must know which files a task will touch, but even the model does not know that before starting. Even if it did, two tasks acquiring overlapping locks is a textbook recipe for deadlock.

Take another angle: git solved this problem twenty years ago. Give each person a working copy, let them make changes independently, and merge at the end. `git worktree` is a much lighter version of clone: one repository grows several working directories, each attached to a branch, while all share the same `.git` history.

The chapter's design fits in one sentence: **isolation comes from copies, not locks.**

---

## Opening a Workspace: Validate the Name First

```python
VALID_WT_NAME = re.compile(r'^[A-Za-z0-9._-]{1,64}$')

def create_worktree(name: str, task_id: str = "") -> str:
    err = validate_worktree_name(name)      # Reject invalid names immediately
    if err:
        return f"Error: {err}"
    path = WORKTREES_DIR / name             # .worktrees/<name>
    ok, result = run_git(["worktree", "add", str(path), "-b", f"wt/{name}", "HEAD"])
    if not ok:
        return f"Git error: {result}"
    if task_id:
        bind_task_to_worktree(task_id, name)
    log_event("create", name, task_id)      # Audit log: record successful events only
```

Name validation is an old friend making its third appearance. s02's `safe_path` guarded file paths, s07's registry guarded skill names, and this regular expression guards workspace names. If a name such as `../../etc` is concatenated into a path, the worktree is created outside the workspace. Whenever a model-provided string becomes part of a path, it must pass inspection first. That rule does not change from chapter to chapter.

The position of `log_event` also matters: it comes after `run_git` succeeds. If logging happened before execution, a failed operation would leave behind a "successful" audit record, turning the log from evidence into a lie.

---

## Binding: The Workspace Is a Task Property, Not a Claim

```python
def bind_task_to_worktree(task_id: str, worktree_name: str):
    task = load_task(task_id)
    task.worktree = worktree_name    # Change only this field
    save_task(task)                  # Status remains pending
```

Notice what it deliberately does not do: it neither changes the status nor sets the owner. Binding answers only "which workspace should this task use?" It does not answer "who should do it?" The autonomous mechanism from s17 therefore stays intact. The task remains on the board until someone claims it, and whoever wins moves into that workspace. The two mechanisms are orthogonal and own separate fields.

Only one thing changes for a teammate: after claiming a task bound to a worktree, all of its `bash`, `read_file`, and `write_file` operations run inside that directory. Alice edits `config.py` under `.worktrees/auth/`; Bob edits `config.py` under `.worktrees/ui/`. They are two physical files, so neither can step on the other.

---

## Closing a Workspace: Count Before Deleting

When a workspace is no longer needed, one question must be answered before dismantling it: is anything inside still waiting to be carried out?

```python
def remove_worktree(name: str, discard_changes: bool = False) -> str:
    ...
    if not discard_changes:
        files, commits = _count_worktree_changes(path)   # Count uncommitted files and unpushed commits
        if files > 0 or commits > 0:
            return (f"Worktree '{name}' has {files} uncommitted file(s) "
                    f"and {commits} unpushed commit(s). "
                    "Use discard_changes=true to force removal, "
                    "or keep_worktree to preserve for review.")
    ok1, _ = run_git(["worktree", "remove", str(path), "--force"])
    run_git(["branch", "-D", f"wt/{name}"])
    log_event("remove", name)
```

By default, the harness refuses to delete a changed worktree. This is the same instinct as "persist before summarizing" in s08 and "obtain the new inventory before deleting the old file" in s09, now appearing for a third time: **before destruction, verify that no orphaned data remains.** Imagine the reverse. A teammate has committed but not merged; the lead casually says "clean up the workspace"; `branch -D` runs, and hours of work vanish while the log contains one tidy `remove` entry.

There are two explicit exits when deletion is truly intended. `discard_changes=true` means "I know what I am throwing away." `keep_worktree` means "preserve the branch for human review." Dangerous operations are allowed, but they must be deliberate decisions spoken aloud, never defaults.

> The real Claude Code has two worktree paths. `EnterWorktree` moves the entire current session into a worktree with a process-level chdir. AgentTool's `isolation: "worktree"` wraps only one subagent without changing the global directory, and unchanged temporary worktrees are cleaned up automatically. It has no task-to-worktree binding field; the task and worktree systems are separate and rely on the model to associate them from context. The teaching version's `worktree` field is an intentional simplification.

---

## Changes from s17

| Component | Before (s17) | After (s18) |
|------|-----------|-----------|
| Working directory | Everyone shares WORKDIR | Each task may bind to a separate worktree |
| Task fields | id/subject/.../blockedBy | +`worktree` |
| New functions | — | `create_worktree`, `bind_task_to_worktree`, `remove_worktree`, `keep_worktree`, `validate_worktree_name` |
| Audit | None | Lifecycle log in `.worktrees/events.jsonl` |
| Teammate execution | Always in the main directory | cwd switches to the task's bound workspace |

---

## Try It

```sh
cd learn-claude-code
python s18_worktree_isolation/code.py
```

1. **Isolation in action**: `Create two tasks: 'write auth notes to notes.md' and 'write UI notes to notes.md'. Create worktrees wt-auth and wt-ui, bind one task to each. Spawn alice and bob to work autonomously.` Both tasks write a file named `notes.md`, yet each remains intact. Compare `cat .worktrees/wt-auth/notes.md` and `cat .worktrees/wt-ui/notes.md`: the contents differ and neither overwrites the other. That is direct evidence for isolation by copy.
2. **Validation**: `Create a worktree named ../../escape`. The name fails the regular expression, an error comes back immediately, and nothing appears outside the workspace.
3. **The removal gate**: after the teammates in experiment 1 finish, run `Remove worktree wt-auth`. It contains unmerged commits, so removal is refused. The error reports the number of files and commits and names both explicit exits. That refusal is the most valuable line in this chapter.

---

## Next

The team can work concurrently, stay isolated, and clean up. Now look back at the agent's toolbox: bash, files, tasks, and teams are all hand-written here. But users have systems of their own, such as an internal Jira or a custom deployment platform. We cannot weld another tool set into `code.py` for every organization.

s19 MCP Plugin → A plugin protocol. External tools join through a standard interface, and the agent does not need to know who implemented them.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
