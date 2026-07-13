from pathlib import Path

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

from s04_prompt_template.code import PROMPT, build_messages, explain


def test_build_messages_fills_template_variables() -> None:
    messages = build_messages("RAG", "初学者", "助教", "通俗")

    joined = "\n".join(str(message.content) for message in messages)
    assert "RAG" in joined
    assert "初学者" in joined
    assert "助教" in joined
    assert "通俗" in joined


def test_prompt_invoke_rejects_missing_variable() -> None:
    with pytest.raises(KeyError, match="style"):
        PROMPT.invoke({"topic": "RAG", "audience": "初学者", "role": "助教"})


def test_explain_returns_model_text() -> None:
    model = GenericFakeChatModel(messages=iter(["RAG 是先找资料，再回答。"]))

    assert explain("RAG", "初学者", "老师", "简短", model=model) == "RAG 是先找资料，再回答。"


def test_readme_explains_why_to_messages_is_explicit() -> None:
    readme = (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8")

    # 锚定概念片段而非整句，避免文风改写误伤断言：
    assert "ChatPromptValue" in readme  # 中间对象有名字
    assert "可以直接传给" in readme  # 不显式 to_messages 也能用
    assert "特意保留" in readme  # 展开这一步是教学选择
