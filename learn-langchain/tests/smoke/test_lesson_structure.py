from pathlib import Path

from scripts.check_lessons import LESSONS, main


def test_lesson_contract() -> None:
    main()


def test_documented_lesson_commands_use_module_execution() -> None:
    root_readme = Path("README.md").read_text(encoding="utf-8")
    assert "uv run python -m s01_first_model.code" in root_readme

    for lesson in LESSONS:
        readme = Path(lesson, "README.md").read_text(encoding="utf-8")
        assert f"uv run python -m {lesson}.code" in readme
