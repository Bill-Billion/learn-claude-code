"""Message helpers kept small enough that lesson code still shows LangChain itself."""

from __future__ import annotations

from typing import Any


def content_to_text(content: Any) -> str:
    """Convert common LangChain message content shapes into readable text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(content)


def message_text(message: Any) -> str:
    """Return text from an AIMessage-like object or plain string."""
    return content_to_text(getattr(message, "content", message))

