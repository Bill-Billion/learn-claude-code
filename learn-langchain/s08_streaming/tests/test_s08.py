# 单 model 测试显式传 tools=[]，继续用最简单的 GenericFakeChatModel；
# 三节点回归测试预设模型会调用 count_words，使用支持 bind_tools 的测试替身。
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, ToolMessage

from s08_streaming.code import collect_final_text, stream_updates
from shared.testing import ToolCallingFakeChatModel


def test_stream_updates_yields_model_update() -> None:
    model = GenericFakeChatModel(messages=iter([AIMessage(content="这是流式最终文本。")]))

    updates = list(stream_updates("解释 streaming", model=model, tools=[]))

    assert updates
    assert "model" in updates[-1]


def test_collect_final_text_returns_last_message() -> None:
    model = GenericFakeChatModel(messages=iter([AIMessage(content="最终答案。")]))

    assert collect_final_text("解释 streaming", model=model, tools=[]) == "最终答案。"


def test_stream_updates_exposes_model_tool_model_progress() -> None:
    model = ToolCallingFakeChatModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "count_words",
                            "args": {"text": "LangChain streams updates"},
                            "id": "call_1",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="一共 3 个词。"),
            ]
        )
    )

    updates = list(stream_updates("统计词数", model=model))

    assert [next(iter(update)) for update in updates] == ["model", "tools", "model"]
    assert isinstance(updates[1]["tools"]["messages"][-1], ToolMessage)
    assert updates[1]["tools"]["messages"][-1].content == "词数：3"
    assert isinstance(updates[2]["model"]["messages"][-1], AIMessage)
    assert updates[2]["model"]["messages"][-1].content == "一共 3 个词。"
