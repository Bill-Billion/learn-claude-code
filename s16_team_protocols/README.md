# s16: Team Protocols — Teammates Need Agreements

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s14 → s15 → `s16` → [s17](../s17_autonomous_agents/) → s18 → s19 → s20
> *"Teammates need agreements"* — Negotiation driven by request-response patterns.
>
> **Harness layer**: Protocols — structured handshakes between agents.

---

The teammates in s15 can work and send messages, but every message is free-form text. Two situations expose the weakness as soon as the stakes rise.

**Shutdown.** The lead wants Alice to stop. Send "you can stop now"? Alice's model may interpret that as advice, praise, or even a new task. Kill the thread directly? The half-written file on disk may be left broken.

**Approval.** Bob wants to refactor the authentication module, a high-risk operation that should begin only after he submits a plan and receives approval. But "here is what I intend to do" and "yes, proceed" are both ordinary chat. If the lead is waiting for two plans at once and receives "okay," which request and which person does it belong to?

Both situations have exactly the same shape: one party sends a request, another responds, and the response must identify which request it answers. Conversation depends on model interpretation, and interpretation can be ambiguous. Collaboration needs the unambiguous part: **a protocol, with machine-checkable fields added to each message.**

![Team Protocols Overview](images/team-protocols-overview.svg)

---

## Three Fields, One State Machine

Exactly three things are missing: a type (this is a shutdown request, not small talk), an ID (which request does this response answer?), and a status (how far has it progressed?). In code:

```python
@dataclass
class ProtocolState:
    request_id: str    # req_042317, unique for every request
    type: str          # "shutdown" | "plan_approval"
    sender: str
    target: str
    status: str        # pending | approved | rejected
    payload: str

pending_requests: dict[str, ProtocolState] = {}
```

When a response arrives, reconcile it by ID. None of the three checks can be omitted:

```python
def match_response(response_type: str, request_id: str, approve: bool):
    state = pending_requests.get(request_id)
    if not state:
        return   # ① Unknown ID: not a request I sent
    if state.type == "shutdown" and response_type != "shutdown_response":
        return   # ② Wrong type: reject a plan response pretending to answer shutdown
    if state.status != "pending":
        return   # ③ Already settled: ignore duplicate responses
    state.status = "approved" if approve else "rejected"
```

Each check blocks a different failure. Without IDs, a lead waiting for two concurrent responses will cross the wires. Without type validation, a malformed message can corrupt the wrong request. Without the settled-state check, a network retry can flip a request that was already approved. The third property also has a name: idempotency. Processing the same message twice has the same effect as processing it once, a basic courtesy in distributed systems.

---

## One Hard Constraint: There Must Be a Single Consumption Entry Point

s15 explained that a mailbox is consuming storage: once read, its contents are deleted. Protocol responses now share that mailbox, which creates a hidden risk. The lead has two ways to read mail, the `check_inbox` tool and the main loop's wake-up path. If either calls `BUS.read_inbox` directly, it may remove a `shutdown_response` without passing it through `match_response`; the corresponding entry in `pending_requests` then remains pending forever.

The fix is to funnel every read through one function, routing before returning:

```python
def consume_lead_inbox(route_protocol: bool = True) -> list[dict]:
    msgs = BUS.read_inbox("lead")
    for msg in msgs:
        req_id = msg.get("metadata", {}).get("request_id", "")
        if req_id and msg.get("type", "").endswith("_response"):
            match_response(msg["type"], req_id, msg["metadata"].get("approve", False))
    return msgs
```

Consuming storage plus multiple consumers requires a single entry point. That rule is not limited to this chapter; it applies to any data source that disappears after being read.

---

## Shutdown Handshake: Acknowledge First, Then Leave

With the protocol foundation in place, shutdown becomes a clean handshake. The lead registers and sends the request:

```python
def run_request_shutdown(teammate: str) -> str:
    req_id = new_request_id()
    pending_requests[req_id] = ProtocolState(request_id=req_id, type="shutdown",
                                             sender="lead", target=teammate,
                                             status="pending", payload="")
    BUS.send("lead", teammate, "Please shut down gracefully.",
             "shutdown_request", {"request_id": req_id})
```

The teammate loop gains a dispatch layer. Protocol messages go to handlers, while ordinary messages are still injected into the conversation:

```python
if msg_type == "shutdown_request":
    BUS.send(name, "lead", "Shutting down gracefully.",
             "shutdown_response", {"request_id": req_id, "approve": True})
    return True   # Acknowledge first, then enter the exit path
```

The order, acknowledge before leaving, matters. If something fails during cleanup, the lead at least knows the request arrived and will not wait forever for an already-dead teammate.

This chapter also delivers the upgrade foreshadowed by s15's ten-round limit. A teammate no longer leaves after finishing its first task. It enters a standby loop and checks the mailbox once per second. A new task sends it back to work; a `shutdown_request` tells it to clean up and leave. Its lifecycle has changed from "stop when the counter reaches zero" to "wait for instructions," matching the real shape previewed in s15.

---

## Plan Approval: The Same State Machine, Reversed

The approval flow uses exactly the same mechanism, with the requester reversed: the teammate initiates and the lead decides.

```
Bob: submit_plan("Refactor auth: add tests first, then change interfaces...") → plan_approval_request (req_xxx)
Lead: review_plan(req_xxx, approve=True)                                     → plan_approval_response
Injected into Bob's conversation: [Plan approved] Proceed with the task.
```

One `request_id` correlation mechanism and one pending → approved/rejected state machine serve both protocols. To add a third later, such as a resource request, follow the same pattern. That is the payoff of turning an "agreement" into structure.

One boundary must be stated honestly: **this is protocol-level approval, not a code-level gate.** After `submit_plan`, the teammate thread keeps running and can still call tools; "wait for approval before acting" depends on the model's compliance. A hard constraint would intercept unapproved operations in the tool dispatch layer. s03 showed that permission in the conversation layer is not permission at the boundary. This teaching version builds only the conversation layer and leaves the boundary layer open.

> In the real Claude Code, shutdown is a three-way protocol: a teammate may answer `shutdown_rejected` with a reason such as "I still have work." After confirmation, the system automatically cleans up terminal panes, releases the teammate's tasks, and removes it from the roster. Execution gating really does intercept unapproved high-risk operations at the tool layer rather than relying on the model's self-restraint.

---

## Changes from s15

| Component | Before (s15) | After (s16) |
|------|-----------|-----------|
| Messages | Free-form text | +type / request_id / metadata structure |
| Protocols | None | `ProtocolState` state machine (pending → approved/rejected) |
| Teammate lifecycle | At most 10 rounds | Standby loop; leaves only on `shutdown_request` |
| New lead tools | — | `request_shutdown`, `request_plan`, `review_plan` |
| New teammate tool | — | `submit_plan` |
| Mailbox consumption | Separate readers | Single `consume_lead_inbox` entry point + protocol routing |

---

## Try It

```sh
cd learn-claude-code
python s16_team_protocols/code.py
```

1. **Graceful shutdown**: `Spawn a teammate 'alice' (a writer) to write a haiku to haiku.md, wait for her result, then ask her to shut down.` The full path is logged: `[protocol] shutdown_request → alice (req_xxxxxx)`, then `[protocol] alice approved shutdown`, and finally `[protocol] shutdown ✓ (req_xxxxxx: approved)`. One ID is followed from issuance to settlement.
2. **Plan approval**: `Spawn 'bob' (an engineer) and ask him to submit a plan for adding a config file, then approve his plan.` Watch the numbered `plan_approval_request` enter the lead's mailbox; only after `review_plan` does Bob receive `[Plan approved]` and begin work.
3. **Standby loop**: in experiment 1, Alice neither exits nor occupies the terminal between delivering the poem and receiving the shutdown request. She waits quietly by the mailbox. Compared with s15's teammates, who left as soon as their work ended, this is what "waiting for instructions" means.

---

## Next

Protocols give collaboration rules, but the lead still assigns every job by hand: "Alice does this, Bob does that." If the board contains ten tasks, the lead must call ten names.

The task system from s12 already has `claim_task`. Could teammates inspect the board, claim their own work, and pick the next task after finishing, leaving the lead to define the problems?

s17 Autonomous Agents → Teammates self-organize without assignments from the lead.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
