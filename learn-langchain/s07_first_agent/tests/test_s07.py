from langchain_core.messages import AIMessage, ToolMessage

from s07_first_agent.code import count_words, run_agent
from shared.testing import ToolCallingFakeChatModel


def fake_tool_calling_model() -> ToolCallingFakeChatModel:
    return ToolCallingFakeChatModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "count_words",
                            "args": {"text": "LangChain teaches tools"},
                            "id": "call_1",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="一共 3 个词。"),
            ]
        )
    )


def test_count_words_tool_is_deterministic() -> None:
    # 和 s06 是同一个工具，行为完全一致：按空白分词计数。
    assert count_words.invoke({"text": "LangChain teaches tools"}) == "词数：3"


def test_agent_calls_tool_then_finishes() -> None:
    model = fake_tool_calling_model()

    result = run_agent("请统计这句话有几个词", model=model)

    assert any(isinstance(message, ToolMessage) for message in result["messages"])
    assert result["messages"][-1].content == "一共 3 个词。"
