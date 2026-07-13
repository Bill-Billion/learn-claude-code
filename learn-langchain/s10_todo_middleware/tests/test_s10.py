from langchain_core.messages import AIMessage

from s10_todo_middleware.code import answer
from shared.testing import ToolCallingFakeChatModel


def test_todo_middleware_binds_write_todos_tool() -> None:
    model = ToolCallingFakeChatModel(messages=iter([AIMessage(content="我会先规划再回答。")]))

    assert answer("把这段文字整理成三点", model=model) == "我会先规划再回答。"
    assert "write_todos" in model.bound_tool_names

