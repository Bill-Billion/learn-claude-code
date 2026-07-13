"""Validate the standalone public course lesson contract."""

from __future__ import annotations

from pathlib import Path

LESSONS = [
    "s01_first_model",
    "s02_messages",
    "s03_system_prompt",
    "s04_prompt_template",
    "s05_structured_output",
    "s06_first_tool",
    "s07_first_agent",
    "s08_streaming",
    "s09_short_term_memory",
    "s10_todo_middleware",
    "s11_retrieval_basics",
    "s12_minimal_rag",
    "s13_comprehensive_project",
]

REQUIRED = ["README.md", "starter.py", "code.py"]

# 过期名称与已知虚构 API：README 改写后曾遗留 `cd learn-langchain-course`，
# 守卫防止同类漂移复发。
STALE_README_PATTERNS = [
    "learn-langchain-course",
    "agent.tools",
]


def main() -> None:
    missing: list[str] = []
    for lesson in LESSONS:
        root = Path(lesson)
        for name in REQUIRED:
            if not (root / name).exists():
                missing.append(f"{lesson}/{name}")
        if not any((root / "tests").glob("test_*.py")):
            missing.append(f"{lesson}/tests/test_*.py")
        if not any((root / "assets").glob("*.mmd")):
            missing.append(f"{lesson}/assets/*.mmd")
        readme = root / "README.md"
        if readme.exists():
            text = readme.read_text(encoding="utf-8")
            for pattern in STALE_README_PATTERNS:
                if pattern in text:
                    missing.append(f"{lesson}/README.md contains stale reference: {pattern}")

    if missing:
        detail = "\n".join(f"- {item}" for item in missing)
        raise SystemExit(f"Lesson contract failed:\n{detail}")

    print(f"OK: {len(LESSONS)} lessons include README, starter, code, tests, and diagrams.")


if __name__ == "__main__":
    main()
