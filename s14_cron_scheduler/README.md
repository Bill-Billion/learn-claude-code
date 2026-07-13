# s14: Cron Scheduler — Produce Work on a Schedule

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s12 → s13 → `s14` → [s15](../s15_agent_teams/) → s16 → ... → s20
> *"Produce work on a schedule; decouple scheduling from execution"* — Cron scheduling, either persistent or session-scoped.
>
> **Harness layer**: Scheduling — an independent thread watches the clock and passes triggers through a queue.

---

After s13, the agent no longer stalls on long operations, but every job still begins with something you say. "Run the tests every morning at 9" and "check CI every 30 minutes" should not require hiring someone to press Enter on schedule.

Your first instinct might be to tell the model, "Remember to run the tests every day at 9." That sentence reveals a fact we have not stated explicitly before: **the model exists only while it is being called.** With no incoming request, it is just a set of static weights. The context may say "every day at 9," but when 9 arrives, nothing wakes up to read it. A sense of time has nowhere to live in the model. It can only live in the harness.

How should the harness provide it? Making the main loop `sleep` until 9 would freeze the entire agent. The answer looks like your alarm clock: a small, independent component that stays awake, watches the schedule, and calls out when the time arrives.

![Cron Scheduler Overview](images/cron-scheduler-overview.svg)

---

## Registration: Stop Bad Expressions at the Door

A task is described by a five-field cron expression (minute, hour, day of month, month, day of week) and validated immediately at registration:

```python
@dataclass
class CronJob:
    id: str
    cron: str        # "0 9 * * *"
    prompt: str      # Message injected into the agent when the job fires
    recurring: bool  # True=recurring, False=one-time
    durable: bool    # True=persist to disk and survive restarts

def schedule_job(cron, prompt, recurring=True, durable=True):
    err = validate_cron(cron)      # Validate first and reject bad expressions immediately
    if err:
        return err
    job = CronJob(id=f"cron_{random.randint(0, 999999):06d}", ...)
    with cron_lock:
        scheduled_jobs[job.id] = job
    if durable:
        save_durable_jobs()        # Persist to .scheduled_tasks.json
```

Why must validation happen at registration? Imagine the opposite: `99 99 * * *` enters the registry and raises only when the scheduler tries to match it. There is only one global scheduler thread, so one bad job could silence every alarm. The teaching version uses two defenses: registration rejects most invalid input, and the scheduler loop wraps each job in its own try/except so one failure is logged without killing the thread.

---

## Matching: Check Every Second, Ring Only Once per Minute

The scheduler thread wakes every second and matches each job's expression against the current time:

```python
def cron_scheduler_loop():
    while True:
        time.sleep(1)
        now = datetime.now()
        minute_marker = now.strftime("%Y-%m-%d %H:%M")   # Notice the date
        with cron_lock:
            for job in list(scheduled_jobs.values()):
                try:
                    if cron_matches(job.cron, now):
                        if _last_fired.get(job.id) != minute_marker:
                            cron_queue.append(job)               # Trigger: enter the queue
                            _last_fired[job.id] = minute_marker  # Do not ring again this minute
                        if not job.recurring:
                            scheduled_jobs.pop(job.id, None)     # Discard one-time jobs after use
                except Exception as e:
                    print(f"[cron error] {job.id}: {e}")         # One bad job cannot kill the thread
```

Two easy mistakes are hidden in `minute_marker`. First, polling every second means the same matching minute is seen 60 times, but the job should fire only once, so the scheduler must remember that it already fired this job during this minute. Second, the marker must include the date. If it stored only `09:00`, a daily job would fire on the first day, see the same marker at 9 the next morning, and never fire again. Bugs like this wait a full day before appearing, which makes them especially unpleasant to diagnose.

`cron_matches` also reproduces a traditional cron oddity faithfully: when both the day-of-month and day-of-week fields are constrained, their semantics are OR, not AND. `0 9 13 * 5` means "at 9 on the 13th or on Friday." Standard cron cannot express "at 9 only when the 13th is a Friday." The teaching version does not "correct" that behavior; compatibility includes compatible quirks.

---

## Decoupling: The Scheduler Only Enqueues Work; It Never Executes It

When the time arrives, the scheduler thread does exactly one thing: append the job to `cron_queue`, then return to watching the clock. It never runs an agent turn itself. There are two reasons. An agent turn may take minutes, which would delay every later trigger if it blocked the scheduler. Also, the user may already be talking to the agent. If two turns write the same history concurrently, messages interleave and the pairing rule from s01 breaks immediately.

An alarm clock only rings; it does not drag you out of bed. A different role handles that part:

```python
def queue_processor_loop():
    """Start a turn automatically when work is queued and the agent is idle."""
    while True:
        time.sleep(0.2)
        if not has_cron_queue():
            continue
        if not agent_lock.acquire(blocking=False):   # No lock = agent is busy; try again later
            continue
        try:
            run_agent_turn_locked()                  # Start an agent turn automatically
        finally:
            agent_lock.release()
```

`agent_lock` is the axis of the entire structure. The path where the user presses Enter and the path where a scheduled job fires compete for the same lock, so only one agent turn can run at a time. Scheduled work never interrupts an active conversation; it waits for the gap after you finish speaking.

The last step happens at the beginning of `agent_loop`, where triggered jobs are injected as user messages through the same "voice of the world" channel:

```python
fired = consume_cron_queue()
for job in fired:
    messages.append({"role": "user", "content": f"[Scheduled] {job.prompt}"})
```

The four layers have separate responsibilities: scheduler (watch the clock) → queue (buffer) → queue processor (find an idle moment) → consumer (inject and execute). Each does one job. That is the entire meaning of "decouple scheduling from execution."

Durable jobs are stored in `.scheduled_tasks.json` and reloaded when the program starts. They are validated again during loading because someone may have damaged the file by editing it on disk; invalid jobs are skipped and logged.

> The real Claude Code allows at most 50 registered jobs, and recurring jobs expire automatically after seven days. Trigger times include jitter: recurring work may be delayed by up to 10% of its interval so every "exactly 9:00" job in the world does not hit the API in the same second, creating a thundering herd. Cron-initiated requests are also marked as low-priority workloads and yield capacity to interactive users when resources are tight.

---

## Changes from s13

| Component | Before (s13) | After (s14) |
|------|-----------|-----------|
| Trigger | User input | +scheduled trigger through cron expressions |
| New threads | Background execution threads | +scheduler thread (1s polling) + queue processor thread |
| New tools | — | `schedule_cron`, `list_crons`, `cancel_cron` (11 total) |
| Persistence | Tasks in `.tasks/` | +durable jobs in `.scheduled_tasks.json` |
| Concurrency control | `background_lock` | +`cron_lock`, `agent_lock` (mutual exclusion between user and scheduled turns) |

---

## Try It

```sh
cd learn-claude-code
python s14_cron_scheduler/code.py
```

1. **Watch it move on its own**: `Schedule a cron job that runs every minute: report the current time`. At the next whole minute, the terminal becomes active without you typing anything: `[cron fire]` → `[queue processor] delivering scheduled work` → `[inject cron]`, followed by a complete agent turn reporting the time. For the first time in the course, work begins without your input.
2. **Bad expressions cannot enter**: `Schedule a cron job with expression "99 99 * * *" that says hi`. Registration rejects it with `minute: Value 99 out of bounds [0-59]`, and the scheduler remains unharmed.
3. **Across restarts**: press `q`, start the program again, and find `[cron] loaded 1 durable job(s)` in the startup log. It still rings at the next whole minute. When you have seen enough, use `Cancel that cron job` and check that `.scheduled_tasks.json` is empty.
4. **It does not interrupt a conversation**: just before the whole minute, ask the agent a question that needs several tool rounds. After the cron fires, `[queue processor]` does not deliver it immediately; it waits until your current turn ends. That is `agent_lock` at work.

---

## Next

The agent can now work and keep time, but it is still a solo worker. A real project has several streams moving in parallel: frontend, backend, and testing are each a job of their own. The subagents from s06 are serial helpers, while the background threads from s13 only run commands. Neither provides "several agents working at once, each responsible for its own area."

s15 Agent Teams → Make the main agent the lead, let it start several teammates with separate jobs, and connect them through file-based mailboxes.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
