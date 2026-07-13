from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from s09_short_term_memory.code import build_agent, run_turn


def test_same_thread_accumulates_history() -> None:
    model = GenericFakeChatModel(messages=iter([AIMessage(content="已记住。"), AIMessage(content="浩然。")]))
    agent = build_agent(model=model)

    run_turn(agent, "thread-1", "记住：我叫浩然。")
    result = run_turn(agent, "thread-1", "我叫什么？")

    assert len(result["messages"]) == 4
    assert result["messages"][-1].content == "浩然。"


def test_different_threads_keep_separate_history() -> None:
    model = GenericFakeChatModel(
        messages=iter([AIMessage(content="线程一。"), AIMessage(content="线程二。")])
    )
    agent = build_agent(model=model, checkpointer=InMemorySaver())

    run_turn(agent, "thread-1", "只属于线程一的消息")
    result = run_turn(agent, "thread-2", "只属于线程二的消息")

    assert len(result["messages"]) == 2
    assert result["messages"][0].content == "只属于线程二的消息"


def test_same_thread_id_in_new_saver_has_no_history() -> None:
    first_agent = build_agent(
        model=GenericFakeChatModel(messages=iter([AIMessage(content="第一轮。")])),
        checkpointer=InMemorySaver(),
    )
    run_turn(first_agent, "same-id", "只存在第一个 saver 中")

    second_agent = build_agent(
        model=GenericFakeChatModel(messages=iter([AIMessage(content="全新对话。")])),
        checkpointer=InMemorySaver(),
    )
    result = run_turn(second_agent, "same-id", "这是第二个 saver")

    assert len(result["messages"]) == 2
    assert result["messages"][0].content == "这是第二个 saver"
