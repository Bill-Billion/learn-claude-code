# s10: System Prompt — Assemble at Runtime, Never Hardcode

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s08 → s09 → `s10` → [s11](../s11_error_recovery/) → s12 → ... → s20
> *"A prompt is assembled, not hardcoded."* Sections + conditional assembly + caching.
>
> **Harness layer**: Runtime prompt assembly.

---

Look back at how the SYSTEM prompt grew. s01 had one identity sentence, s05 added TodoWrite guidance, s07 appended the skill catalog, and s09 appended the memory index. Every lesson welded another fragment onto the same string:

```python
SYSTEM = (
    f"You are a coding agent at {WORKDIR}. "
    "Use tools to solve tasks. Act, don't explain. "
    "Before starting any multi-step task, use todo_write. "
    "Skills are available via list_skills and load_skill. "
    "Relevant memories are injected below when available. "
    # ... weld on another fragment for every capability
)
```

Three problems follow. Changing projects means rewriting the whole string, because generic and project-specific instructions can no longer be separated. A new instruction may contradict an old one, but conflicts hide inside one blob. And s08 explained the prompt cache: its prefix must match exactly. When one character in a monolithic string is dynamic, the entire SYSTEM becomes a new prefix on every turn.

All three problems begin with the same treatment: split the string apart.

![System Prompt Overview](images/system-prompt-overview.svg)

---

## Split by Topic: One Section, One Concern

```python
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    "tools": "Available tools: bash, read_file, write_file.",
    "workspace": f"Working directory: {WORKDIR}",
    "memory": "Relevant memories are injected below when available.",
}
```

Sections can now evolve independently: changing `tools` does not touch `identity`, and adding `memory` does not modify `workspace`. Conflicts become visible because each section talks about one subject.

Splitting is only the first step. Who decides which sections belong in this turn?

---

## Assemble from State, Not Keyword Guesses

```python
def assemble_system_prompt(context: dict) -> str:
    sections = []

    # Always present: every turn needs identity, tools, and workspace
    sections.append(PROMPT_SECTIONS["identity"])
    sections.append(PROMPT_SECTIONS["tools"])
    sections.append(PROMPT_SECTIONS["workspace"])

    # Conditional: use real state, not words in the conversation
    memories = context.get("memories", "")
    if memories:
        sections.append(f"Relevant memories:\n{memories}")

    return "\n\n".join(sections)
```

The decision signal matters. Include the memory section when `.memory/MEMORY.md` exists and is non-empty — a fact in the filesystem. An alternative is to look for words such as "remember" or "preference" in the user's message, which is only a guess. State-driven assembly is deterministic and testable; keyword-driven assembly fails when the user changes phrasing.

The context itself comes from real state:

```python
def update_context(context: dict, messages: list) -> dict:
    memories = ""
    if MEMORY_INDEX.exists():                       # Inspect the filesystem, not the conversation
        content = MEMORY_INDEX.read_text().strip()
        if content:
            memories = content
    return {
        "enabled_tools": list(TOOL_HANDLERS.keys()),  # Tools actually registered
        "workspace": str(WORKDIR),
        "memories": memories,
    }
```

The loop recomputes context after each turn's tools execute. The reason is practical: tools change the world. If the model just wrote `MEMORY.md`, the next prompt should reflect that fact.

---

## Cache: Do Not Assemble the Same State Twice

Context often stays unchanged across turns, so rebuilding the string is wasted work. Add a cache keyed by serialized context:

```python
def get_system_prompt(context: dict) -> str:
    global _last_context_key, _last_prompt
    key = json.dumps(context, sort_keys=True, ensure_ascii=False, default=str)
    if key == _last_context_key and _last_prompt:
        return _last_prompt                     # [cache hit]
    _last_context_key = key
    _last_prompt = assemble_system_prompt(context)
    return _last_prompt                         # [assembled]
```

Why `json.dumps(sort_keys=True)` rather than the convenient `hash()`? Two bad cases: Python randomizes string hashes per process, so the same context gets a different key on another run; and context contains lists and dictionaries, which make `hash()` raise `unhashable type`. Deterministic serialization is the stable option, while `sort_keys` removes dictionary-order differences.

One honest boundary: this cache saves string assembly inside the local process. It is not the API-side prompt cache from s08. But sections prepare for that cache too: stable sections can move to the front and changing sections to the end, keeping the stable prefix alive longer.

> Real Claude Code has a variable number of sections controlled by feature flags, output styles, and runtime modes. Static sections form one global cache block, while `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` keeps dynamic sections outside it. The only universally volatile section is `mcp_instructions`, because MCP servers can connect or disconnect between turns. The teaching version's four sections and two strategies are the smallest form of the same structure.

---

## Changes from s09

| Component | Before (s09) | After (s10) |
|-----------|--------------|-------------|
| Prompt | Hardcoded SYSTEM string | `PROMPT_SECTIONS` + `assemble_system_prompt` |
| Cache | None | `get_system_prompt` (`json.dumps` detection + cache) |
| New functions | — | `assemble_system_prompt`, `get_system_prompt`, `update_context` |
| Tools | 6 | 3 — narrowed to bash, read_file, write_file to focus on prompt assembly |
| Loop | Uses fixed SYSTEM | Recompute context after tools, then obtain the prompt |

---

## Try It

```sh
cd learn-claude-code
python s10_system_prompt/code.py
```

The terminal exposes the whole lesson through two labels: `[assembled] sections: ...` means the prompt was rebuilt and lists its sections; `[cache hit]` means state stayed unchanged and the cached prompt was reused.

1. `Read the file README.md`: note which three sections appear on the first assembly. If you recently ran s09 and `.memory/` contains memory files, `memory` appears too.
2. Ask another question. This time you should see `[cache hit]` because context did not change.
3. `Create a file called .memory/MEMORY.md with content "- [test](test.md) — test memory"` if no memory exists. After the write, `[assembled]` appears again with `memory` added to the section list. The model changed the filesystem and the prompt followed it: state-driven assembly in action.

---

## What's Next

The prompt is assembled and the capabilities are present, but the entire system assumes every API call succeeds. The real world includes network failures, rate limits, truncated output, and context overflow. These are routine, not exceptional. The current code crashes on any of them.

s11 Error Recovery → Four recovery paths: raise the token limit, compact context, back off exponentially, and switch models.

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
