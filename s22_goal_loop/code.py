"""
s22_goal_loop — /goal session goal loop (teaching version)

Clean-room behavioral reconstruction of Claude Code's `/goal` command. Grounded
in @anthropic-ai/claude-code@2.1.177 observed behavior
(reverse-research/cc_goal_loop), NOT leaked source.

Idea:
  s01-s21 end a turn when the model emits no tool_use. `/goal` adds a
  host-owned turn-completion GATE: the user sets a stopping CONDITION, and after
  every turn a separate evaluator judges whether trusted transcript evidence
  satisfies it. Not satisfied -> the gate blocks the stop and feeds a
  continuation into the next turn. Satisfied -> the active goal is cleared.

  So the core contrast with s01 is one extra check before "return":

      # s01: the model says stop -> stop
      if not has_tool_use(response):
          return
      # s22: when it wants to stop, pass the goal gate first
      if not has_tool_use(response):
          verdict = goal.evaluate_after_turn()
          if verdict == "continuing":
              continue                 # not met -> push it back
          return                       # met / over budget / no goal -> really stop

Run:
  python code.py          # /goal until tests pass + deploy green; watch the gate

Teaching simplifications (vs real /goal and runtime.mjs):
  - The evaluator is a deterministic keyword check, not a small/fast model.
  - One mock task-notification produces the trusted evidence; the loop / monitor
    / background-task plane (s13/s14) is out of scope — this chapter is just the
    goal gate.
  - The evidence trust boundary is the faithful part: only task-notification /
    monitor-line origins count as evidence, so the `/goal` command text, the
    continuation reminder, and plain assistant prose can NOT satisfy the goal.
"""

import itertools
import sys

# ---- ids + a one-line event stream so the gate is visible ----
_ids = itertools.count(1)


def make_id(prefix):
    return f"{prefix}-{next(_ids):03d}"


def event(lane, etype, detail=""):
    print(f"  · {lane:<6} {etype:<26} {detail}")


# A message's origin.kind is the TRUST LABEL that decides whether it can count
# as goal evidence. Trusted async origins land real tool/task evidence; user /
# slash-command / active-goal (the continuation reminder) / assistant do not.
TRUSTED_EVIDENCE_ORIGINS = {"task-notification", "monitor-line"}


class Message:
    def __init__(self, role, content, origin):
        self.role = role
        self.content = content
        self.origin = origin or {"kind": "user"}


# ============================================================
# CommandQueue — continuation prompts live here (mirrors CommandQueue)
# ============================================================
class CommandQueue:
    PRIORITY = {"now": 0, "next": 1, "later": 2}

    def __init__(self):
        self.items = []

    def enqueue(self, value, priority="next", origin=None):
        item = {"id": make_id("cmd"), "priority": priority,
                "origin": origin or {}, "value": value}
        self.items.append(item)
        return item

    def dequeue(self, include_goal_continuations=True):
        # Goal continuations and the external async inbox are NOT the same drain.
        # With include_goal_continuations=False an inbox drain skips them, so a
        # goal can't be advanced (or blocked) before real evidence arrives.
        self.items.sort(key=lambda i: self.PRIORITY.get(i["priority"], 1))
        for idx, item in enumerate(self.items):
            if include_goal_continuations or item["origin"].get("kind") != "active-goal":
                return self.items.pop(idx)
        return None

    def remove_by_origin(self, kind):
        before = len(self.items)
        self.items = [i for i in self.items if i["origin"].get("kind") != kind]
        return before - len(self.items)

    def __len__(self):
        return len(self.items)


# ============================================================
# GoalRuntime — the turn-completion gate (mirrors GoalRuntime)
# ============================================================
class GoalRuntime:
    def __init__(self, transcript, queue):
        self.transcript = transcript          # shared session transcript
        self.queue = queue
        self.active = None

    def set_goal(self, objective, max_turns=20):
        # start_index marks the evidence window. The /goal command line is
        # already recorded, so it sits OUTSIDE the window and can't satisfy
        # itself.
        self.active = {
            "id": make_id("goal"), "objective": objective, "status": "active",
            "start_index": len(self.transcript), "max_turns": max_turns,
            "checks": 0, "continuation_turns": 0,
        }
        event("goal", "goal_started", f"{self.active['id']} :: {objective}")
        return self.active

    def clear(self, reason="cleared"):
        if not self.active:
            return
        self.active["status"] = reason
        self.queue.remove_by_origin("active-goal")
        event("goal", "goal_cleared", reason)
        self.active = None

    def evidence_text(self):
        """The trust boundary. Three filters keep self-satisfying text out:
        drop slash-command origins, drop /goal command lines, and keep ONLY
        trusted external async origins (task-notification / monitor-line)."""
        if not self.active:
            return ""
        out = []
        for m in self.transcript[self.active["start_index"]:]:
            if m.origin.get("kind") == "slash-command":
                continue
            if m.role == "user" and m.content.strip().startswith("/goal"):
                continue
            if m.origin.get("kind") not in TRUSTED_EVIDENCE_ORIGINS:
                continue
            out.append(f"{m.role}: {m.content}")
        return "\n".join(out)

    def goal_satisfied(self):
        # Real Claude Code routes this to a small/fast evaluator model reading
        # the evidence window. The teaching version is a deterministic keyword
        # check so the lifecycle is reproducible.
        objective = self.active["objective"].lower()
        evidence = self.evidence_text().lower()
        wants_tests = "test" in objective
        wants_deploy = "deploy" in objective or "green" in objective
        tests_ok = not wants_tests or "tests passed" in evidence or "test passed" in evidence
        deploy_ok = not wants_deploy or "deploy green" in evidence or "deployment green" in evidence
        if any(k in objective for k in ("until", "pass", "green")):
            return tests_ok and deploy_ok
        return objective in evidence

    def evaluate_after_turn(self):
        """The gate, run after every turn. Returns completed / continuing /
        blocked / none."""
        g = self.active
        if not g or g["status"] != "active":
            return "none"
        g["checks"] += 1
        satisfied = self.goal_satisfied()
        event("goal", "goal_evaluated", f"check #{g['checks']} satisfied={satisfied}")
        if satisfied:
            g["status"] = "completed"
            self.queue.remove_by_origin("active-goal")
            event("goal", "goal_completed", g["id"])
            self.active = None
            return "completed"
        if g["continuation_turns"] < g["max_turns"]:
            g["continuation_turns"] += 1
            self.queue.enqueue(
                value=(f"Continue working toward active goal {g['id']}. Use tool/task "
                       "evidence; do not treat this reminder as completion evidence."),
                priority="next", origin={"kind": "active-goal", "goal_id": g["id"]})
            event("goal", "goal_continuation_enqueued",
                  f"turn {g['continuation_turns']}/{g['max_turns']}")
            return "continuing"
        g["status"] = "blocked"
        self.queue.remove_by_origin("active-goal")
        event("goal", "goal_blocked", f"exceeded {g['max_turns']} turns")
        self.active = None
        return "blocked"


# ============================================================
# Session — the main loop host with a Stop gate (mirrors submit / drain)
# ============================================================
class Session:
    def __init__(self):
        self.transcript = []
        self.queue = CommandQueue()
        self.goal = GoalRuntime(self.transcript, self.queue)

    def _add(self, role, content, origin):
        self.transcript.append(Message(role, content, origin))

    def submit(self, text, origin=None):
        """One turn: record the input, run a (mock) assistant turn, then let the
        goal gate evaluate. `origin` carries the trust label."""
        origin = origin or {"kind": "user"}
        self._add("user", text, origin)        # input recorded with its origin
        kind = origin["kind"]

        if kind == "user" and text.strip().startswith("/goal"):
            arg = text.strip()[5:].strip()
            self._add("assistant", f"(slash) /goal {arg}", {"kind": "slash-command"})
            if arg in ("", "clear", "stop", "off"):
                self.goal.clear()
            else:
                self.goal.set_goal(arg)
        elif kind in TRUSTED_EVIDENCE_ORIGINS:
            # The input itself (recorded above with a trusted origin) is the
            # evidence; the assistant just observes it.
            event("turn", f"observe {kind}", text[:48])
            self._add("assistant", f"Observed {kind}: {text}", origin)
        elif kind == "active-goal":
            event("turn", "continue-goal", "(reminder is not evidence)")
            self._add("assistant", "Continuing the goal; checking task/monitor evidence.", origin)
        else:
            event("turn", "assistant-turn", text[:48])
            self._add("assistant", f"assistant handled: {text}", {"kind": "assistant"})

        return self.goal.evaluate_after_turn()    # <-- the Stop gate

    def drain_goal_continuation(self):
        """Pull one goal continuation back into the loop — explicit, separate
        from any external async-inbox drain."""
        item = self.queue.dequeue(include_goal_continuations=True)
        if item and item["origin"].get("kind") == "active-goal":
            return self.submit(item["value"], origin=item["origin"])
        return None


# ============================================================
# Demo
# ============================================================
def banner(text):
    print(f"\n— {text} —")


def main(argv):
    s = Session()

    banner("1. set a goal (the gate is now armed; window starts after the command)")
    print("user> /goal until tests passed and deploy green")
    s.submit("/goal until tests passed and deploy green")

    banner("2. model works, no TRUSTED evidence yet -> the gate keeps it going")
    s.drain_goal_continuation()
    s.submit("Inspecting the failing tests and the deploy config.")

    banner("3. plain user text 'tests passed' is NOT trusted -> still not satisfied")
    s.submit("tests passed, trust me")
    s.drain_goal_continuation()
    print(f"   active goal still open: {s.goal.active is not None}")

    banner("4. a background task lands a task-notification (trusted) -> satisfied")
    verdict = s.submit("tests passed; deploy green", origin={"kind": "task-notification"})
    print(f"   final verdict: goal {verdict}")

    banner("5. budget: a goal that never gets evidence blocks after max_turns")
    s2 = Session()
    s2.goal.set_goal("until tests passed", max_turns=2)
    verdict = "continuing"
    while verdict == "continuing":
        verdict = s2.submit("still working, no task evidence yet")
    print(f"   final verdict: goal {verdict}")


if __name__ == "__main__":
    main(sys.argv[1:])
