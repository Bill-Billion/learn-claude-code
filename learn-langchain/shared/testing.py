"""Test helpers that make LangChain agent examples runnable without provider keys."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.tools import BaseTool
from pydantic import Field


class ToolCallingFakeChatModel(GenericFakeChatModel):
    """A fake chat model that satisfies the `bind_tools` contract used by agents.

    The real ``BaseChatModel.bind_tools`` returns a *new* bound model rather than
    mutating and returning ``self``. This fake mirrors that: it returns a fresh
    instance. To keep tests able to inspect what got bound, the new instance
    shares the same ``bound_tool_names`` list object as the original, so appends
    made during ``create_agent`` are visible from the model the test holds.
    """

    bound_tool_names: list[str] = Field(default_factory=list)

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> ToolCallingFakeChatModel:
        # Shallow copy shares the mutable bound_tool_names list by reference,
        # so the returned instance and the original observe the same appends.
        bound = self.model_copy()
        bound.bound_tool_names.extend(getattr(tool, "name", str(tool)) for tool in tools)
        return bound
