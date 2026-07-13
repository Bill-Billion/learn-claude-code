# s15: Agent Teams — When One Is Not Enough, Form a Team

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s13 → s14 → `s15` → [s16](../s16_team_protocols/) → s17 → s18 → s19 → s20
> *"When one is not enough, form a team"* — File-based inboxes and teammate threads.
>
> **Harness layer**: Teams — multi-agent collaboration and a message bus.

---

A job like "refactor the entire backend" unfolds into four workstreams: authentication, the database layer, API routes, and tests. If one agent handles them serially, details of the authentication module have already been pushed out of context by the time it reaches the API routes.

Can the subagents from s06 share the load? Almost, but not quite. `spawn_subagent` is a blocking call: after dispatching one, the main agent stands still until it returns, so the four workstreams still form a queue. A subagent also has only one communication channel, its return value. If it discovers halfway through that "the database schema does not match the task description," it cannot come back and ask a question.

What we really need is coworkers, not temporary help. Coworkers have two properties that subagents lack: **they work at the same time** and **they can send messages at any time**. s13 already gave us the answer to concurrent work (threads). Messages at any time are the subject of this chapter.

![Agent Teams Overview](images/agent-teams-overview.svg)

---

## Coworkers Do Not Return; They Send Messages

Function calls use a one-shot request-response model: the caller waits, the callee returns, and the channel closes. Team collaboration needs a different model. Everyone has a mailbox; anyone can leave a message, and the recipient reads it when free.

`MessageBus` is that mailbox system, with an implementation simple enough to see through directly:

```python
class MessageBus:
    def send(self, from_agent, to_agent, content, msg_type="message"):
        msg = {"from": from_agent, "to": to_agent,
               "content": content, "type": msg_type, "ts": time.time()}
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        with open(inbox, "a") as f:                  # Sending = append one line to the recipient's file
            f.write(json.dumps(msg) + "\n")

    def read_inbox(self, agent) -> list[dict]:
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        if not inbox.exists():
            return []
        msgs = [json.loads(line) for line in inbox.read_text().splitlines() if line.strip()]
        inbox.unlink()                               # Receiving = delete after reading (consuming read)
        return msgs

    def peek(self, agent) -> bool:
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        return inbox.exists() and inbox.stat().st_size > 0   # Check presence without touching contents
```

Why files rather than an in-memory queue? There are two reasons. Observability: the `.mailboxes/` directory is right there, and at any moment `cat` shows who is saying what to whom. That is much more useful than logs when debugging a multi-agent system. Extensibility: files naturally cross process boundaries. Today's teammates may be threads; tomorrow they may be separate processes or even separate machines, while the mailbox interface remains unchanged.

Two boundaries need to be explicit. Reads are consuming: after the file is read, it is deleted, so received messages must be handled immediately and there is no second copy if one is lost. The teaching version also has no file lock, so two writers may interleave lines under an unlucky timing. The real Claude Code protects every append with `proper-lockfile`.

---

## A Teammate: The Same Loop, Plus a Name and a Mailbox

The old pattern appears for a third time. Like the subagent in s06, a teammate is another copy of the s01 loop with different configuration. It has a name and role in its own system prompt, owns a mailbox, and checks that mailbox before every round:

```python
def spawn_teammate_thread(name: str, role: str, prompt: str) -> str:
    system = (f"You are '{name}', a {role}. "
              f"Use tools to complete tasks. Send results via send_message to 'lead'.")

    def run():
        messages = [{"role": "user", "content": prompt}]
        for _ in range(10):                          # Teaching version: at most 10 rounds
            inbox = BUS.read_inbox(name)             # Check the mailbox before each round
            if inbox:
                messages.append({"role": "user",
                                 "content": f"<inbox>{json.dumps(inbox)}</inbox>"})
            response = client.messages.create(
                model=MODEL, system=system, messages=messages[-20:],   # Sliding window
                tools=sub_tools, max_tokens=8000)
            ...
        BUS.send(name, "lead", summary, "result")    # Send the lead a summary before leaving
        active_teammates.pop(name, None)             # Remove itself from the roster

    threading.Thread(target=run, daemon=True).start()
```

The tool set is narrowed as usual: `bash`, `read_file`, `write_file`, and `send_message`. It does not include `spawn_teammate`, so teammates cannot recruit more teammates, following the anti-recursion rule from s06. Context management uses a `messages[-20:]` sliding window instead of the compaction pipeline from s08. Teammates are short-lived, with a ten-round limit, and the most recent twenty messages cover their entire lives; a four-step cleanup pipeline would be needless overhead.

The lead gains three tools: `spawn_teammate` to recruit, `send_message` to communicate, and `check_inbox` to read mail.

---

## The Lead's Terminal: From Request-Response to an Event Loop

The first fourteen chapters all used the same main-program shape: `input()` waits for you, runs one turn, then waits again. That no longer works because teammate reports may arrive at any time, and they cannot depend on you pressing Enter at exactly that moment.

The main program becomes an event loop. Two sources, your input and background activity, flow into one queue; whichever arrives is handled next:

```python
def inbox_poller():
    while True:
        time.sleep(1)
        if BUS.peek("lead") or has_pending_background():
            events.put(("wake", None))       # Mail or completed background work: request a wake-up turn

while True:
    kind, payload = events.get()
    if kind == "user":
        history.append({"role": "user", "content": payload})
    else:  # wake
        inbox = BUS.read_inbox("lead")
        ...
        if not parts:
            continue                          # A previous wake drained it; skip
        history.append({"role": "user", "content": "\n".join(parts)})
    agent_loop(history, context)
```

Each of the two defenses addresses a real failure mode.

**Wake-ups must be idempotent.** The poller checks every second, so one teammate message may enqueue two wake events. The first drains the mailbox; the second must see that there is nothing left and skip. Without that `continue`, every message would come with a bonus empty API call.

**The poller must not consult the roster.** The intuitive implementation is "check for mail only while a teammate is alive." But when a teammate leaves, it first sends its final summary and then unregisters itself, and those operations are not atomic. If the roster gates polling, a final message that becomes visible just after unregistration may never be collected. The poller therefore trusts only the mailbox: if mail exists, wake up, whether or not the sender is still listed.

> In the real Claude Code, teammates do not stop after ten rounds. They enter an idle loop after finishing and wait by the mailbox until a `shutdown_request` arrives. Mailbox writes use file locks. Teams also have their own hook events, `TeammateIdle` and `TaskCompleted`, where external systems can attach behavior.

---

## Changes from s14

| Component | Before (s14) | After (s15) |
|------|-----------|-----------|
| Number of agents | 1 | 1 lead + N teammate threads |
| Communication | None | `MessageBus` file mailboxes (`.mailboxes/*.jsonl`) |
| New tools | — | `spawn_teammate`, `send_message`, `check_inbox` (14 total) |
| Main program | Request-response through `input()` | Event loop (user input + wake events) |
| Teammate lifecycle | — | At most 10 rounds; sends summary and unregisters on completion |

---

## Try It

```sh
cd learn-claude-code
python s15_agent_teams/code.py
```

1. **Concurrency and automatic wake-up**: `Spawn two teammates: 'poet' (a poet) who writes a short poem to poem.md, and 'critic' (a critic) who reviews the first paragraph of README.md. Wait for both reports.` Watch `[teammate] poet spawned` and `[teammate] critic spawned` appear almost together while their `[bus]` messages interleave. When reports return, the terminal prints `[wake: N inbox ...]` and starts another turn without your input, ending with `[all teammates done]`.
2. **See the communication itself**: give a teammate a slow job, such as `Spawn a teammate 'worker' who runs 'sleep 15' and then writes done.md`. While it works, tell the lead `Run ls -la .mailboxes/`. The mailbox files are sitting there; this collaboration system's entire infrastructure is only a few JSONL files.
3. **Consuming reads**: after everything finishes, enter `Check your inbox`. You will probably get `(inbox empty)`. The messages were not lost; the wake-up mechanism fetched them first and injected them into the conversation. A read-and-delete mailbox has only one copy, and whoever collects it first owns it. That behavior is worth experiencing directly.

---

## Next

Teammates can work and communicate, but everything remains free-form. Messages have no structure, and if the lead wants a teammate to stop, it can only look on helplessly. Killing the thread directly is unsafe because it may be halfway through writing a file.

s16 Team Protocols → Add types and IDs to messages; shutdown requires a handshake, and requests require acknowledgements.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
