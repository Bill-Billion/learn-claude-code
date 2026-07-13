from pathlib import Path

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from s03_system_prompt.code import ask_with_role, build_role_messages


def test_build_role_messages_starts_with_system_message() -> None:
    messages = build_role_messages("什么是模板？", "老师", "简洁")

    assert isinstance(messages[0], SystemMessage)
    assert isinstance(messages[1], HumanMessage)
    assert "老师" in str(messages[0].content)
    assert messages[1].content == "什么是模板？"


def test_ask_with_role_returns_model_text() -> None:
    model = GenericFakeChatModel(messages=iter(["模板就是可复用的输入结构。"]))

    assert ask_with_role("什么是模板？", "老师", "简洁", model=model) == "模板就是可复用的输入结构。"


def test_readme_describes_system_message_as_convention_not_enforcement() -> None:
    readme = (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8")

    # 锚定概念片段而非整句，避免文风改写误伤断言：
    assert "用户提问" in readme and "分离" in readme  # 规则与提问分离
    assert "列表首位" in readme  # 通常置首是约定
    assert "并不强制" in readme  # 框架不强制，是最佳实践
    assert "不是权限系统" in readme  # 行为引导，不是权限边界
    assert "只会验证消息列表的结构" in readme  # 离线测试的证据边界
