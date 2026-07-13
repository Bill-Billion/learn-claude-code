from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage

from s02_messages.code import build_messages, continue_conversation


class RecordingModel:
    def __init__(self) -> None:
        self.seen_messages = None

    def invoke(self, messages):
        self.seen_messages = messages
        return AIMessage(content="已收到显式历史。")


def test_build_messages_keeps_roles_explicit() -> None:
    messages = build_messages("下一步学什么？")

    assert isinstance(messages[0], HumanMessage)
    assert isinstance(messages[1], AIMessage)
    assert isinstance(messages[2], HumanMessage)
    assert messages[2].content == "下一步学什么？"


def test_continue_conversation_invokes_model_with_messages() -> None:
    model = RecordingModel()

    assert continue_conversation("下一步学什么？", model=model) == "已收到显式历史。"
    assert model.seen_messages is not None
    assert [type(message) for message in model.seen_messages] == [
        HumanMessage,
        AIMessage,
        HumanMessage,
    ]
    assert model.seen_messages[2].content == "下一步学什么？"


def test_readme_distinguishes_string_convenience_from_role_preservation() -> None:
    readme = (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8")

    assert "字符串仍然可以直接传给 `model.invoke()`" in readme
    assert "消息列表" in readme and "role" in readme
