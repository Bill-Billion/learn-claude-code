import ast
from pathlib import Path

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

from s01_first_model.code import ask_once


def test_ask_once_returns_text_from_ai_message() -> None:
    model = GenericFakeChatModel(messages=iter(["你好，LangChain。"]))

    assert ask_once("打个招呼", model=model) == "你好，LangChain。"


def test_flow_separates_model_initialization_from_query_invocation() -> None:
    flow = (Path(__file__).parents[1] / "assets" / "flow.mmd").read_text(encoding="utf-8")

    assert "A[model name] --> B[init_chat_model]" in flow
    assert "B --> C[model]" in flow
    assert "D[query string] --> E[model.invoke]" in flow
    assert "C --> E" in flow


def test_starter_imports_os_before_reading_environment() -> None:
    starter = (Path(__file__).parents[1] / "starter.py").read_text(encoding="utf-8")
    tree = ast.parse(starter)

    imported_modules = {
        alias.name
        for node in tree.body
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    assert "os" in imported_modules


def test_readme_does_not_claim_string_input_stops_working() -> None:
    readme = (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8")

    assert "不再吃裸字符串" not in readme
    assert "显式消息列表" in readme
