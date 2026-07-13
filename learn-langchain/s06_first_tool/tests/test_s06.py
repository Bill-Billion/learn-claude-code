from s06_first_tool.code import count_words, run_count_words


def test_tool_metadata_comes_from_function() -> None:
    assert count_words.name == "count_words"
    assert "词数" in (count_words.description or "")


def test_tool_argument_schema_comes_from_type_hint() -> None:
    assert count_words.args["text"]["type"] == "string"


def test_run_count_words_invokes_tool() -> None:
    assert run_count_words("LangChain teaches tools") == "词数：3"
