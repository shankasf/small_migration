"""Attached files are always in front of the specialists that answer the user.

Regression for a chat where a design document was attached: the generating
agents read it, but the conversational follow-ups only saw its filename, never
read it, and told the user they could not access it. Fixtures are synthetic.
"""
import asyncio

from langchain_core.messages import HumanMessage, SystemMessage

from fakes import FakeGateway, call, turn_context, FakeRegistry
from test_turn_graph import Harness, route
from workflow.agents import formatting
from workflow.agents.conversational import ConsultantAgent, HistoryAgent, RepositoryAgent
from workflow.agents.formatting import files_block, history_excerpt, history_messages
from workflow.prompts import prompt
from workflow.tools.files import FILE_TOOLS, PAGE_CHARS, page_of

TABLE = "\n".join(f"| ENT-{i:04d} | {{\"tier\": \"gold\", \"seats\": {i}}} |" for i in range(260))
DESIGN = ("# Widget design\n\n## Entitlement Data (JSON)\n\n| key | json |\n|---|---|\n" + TABLE
          + "\n\n## Closing note\nEND-OF-DESIGN-MARKER\n")


def brief_for(agent, files, message="why is entitlement_data empty?"):
    context = turn_context(FakeRegistry())
    context.workspace.message = message
    context.workspace.files = dict(files)
    return agent.brief(context, {})


def test_design_doc_is_long_enough_to_matter():
    assert 10_000 < len(DESIGN) < 150_000


def test_consultant_brief_carries_the_whole_file_in_the_human_message():
    messages = brief_for(ConsultantAgent(), {"design.md": DESIGN})
    system, human = messages[0], messages[-1]
    assert isinstance(system, SystemMessage) and isinstance(human, HumanMessage)
    assert "ENT-0259" in human.content and "END-OF-DESIGN-MARKER" in human.content
    assert "## Entitlement Data (JSON)" in human.content
    assert "why is entitlement_data empty?" in human.content
    # Untrusted file text never enters the system message.
    assert "ENT-0001" not in system.content and "design.md" in system.content
    assert "Attachment load report" not in human.content  # nothing was cut, so nothing to report


def test_history_agent_sees_attached_files_not_only_search_excerpts():
    messages = brief_for(HistoryAgent(), {"design.md": DESIGN}, "are you not able to read the attached markdown?")
    assert "END-OF-DESIGN-MARKER" in messages[-1].content
    assert "search excerpt is only a fragment" in messages[0].content


def test_repository_agent_also_gets_the_attachments():
    messages = brief_for(RepositoryAgent(), {"design.md": DESIGN})
    assert "END-OF-DESIGN-MARKER" in messages[-1].content


def test_no_files_leaves_the_message_untouched():
    messages = brief_for(ConsultantAgent(), {}, "what does NULLIF do?")
    assert messages[-1].content == "what does NULLIF do?"
    assert "No files are attached" in messages[0].content


def test_over_budget_file_is_cut_and_the_model_is_told_to_say_so():
    agent = ConsultantAgent()
    agent.files_budget = 2_000
    human = brief_for(agent, {"design.md": DESIGN, "small.sql": "select 1"})[-1].content
    assert "END-OF-DESIGN-MARKER" not in human
    assert "select 1" in human  # a small file is never starved by a large one
    assert "Only partly loaded: design.md" in human
    assert "tell the user plainly which file was not fully loaded" in human
    assert "get_file_content" in human  # the consultant can read the rest


def test_history_truncation_note_does_not_offer_a_tool_it_lacks():
    agent = HistoryAgent()
    agent.files_budget = 2_000
    human = brief_for(agent, {"design.md": DESIGN})[-1].content
    assert "Only partly loaded: design.md" in human and "get_file_content" not in human


def test_empty_unparsed_and_multi_version_files_are_reported():
    files = {"empty.csv": "  \n", "book.xlsx": "PK\x03\x04\x14\x00garbage",
             "m.sql [v1; aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa]": "select 1",
             "m.sql [v2; bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb]": "select 2"}
    block = files_block(files)
    assert "Empty, no text was extracted: empty.csv" in block
    assert "Could not be converted to text" in block and "book.xlsx" in block and "garbage" not in block
    assert "Several versions of the same file are attached" in block
    assert "select 1" in block and "select 2" in block


def test_budget_exhausted_files_are_named_not_dropped():
    block = files_block({"a.md": "x" * 50, "b.md": "y" * 50}, budget=0)
    assert "Not loaded at all (attachment budget reached): a.md, b.md" in block


def test_end_to_end_consultant_answers_from_the_file_without_calling_a_tool():
    harness = Harness()
    harness.models.script("router", route("consult"))
    harness.models.script("consultant", "The design lists entitlement JSON per key, e.g. ENT-0007.")
    harness.turn("do you not understand what it says?", files={"design.md": DESIGN})
    request = harness.models.requests("consultant")[0]["messages"]
    assert "END-OF-DESIGN-MARKER" in request[-1].content


def test_end_to_end_history_agent_sees_the_file_alongside_its_search():
    gateway = FakeGateway(**{"chat_search:history": {"matches": [{"excerpt": "## Entitlement Data (JSON)"}]}})
    harness = Harness(gateway)
    harness.models.script("router", route("history"))
    harness.models.script("history", call("search_chat_history", query="entitlement", scope="current"),
                          "The table lists ENT-0000 to ENT-0259.")
    harness.turn("find my earlier chats about entitlements", files={"design.md": DESIGN})
    assert "END-OF-DESIGN-MARKER" in harness.models.requests("history")[0]["messages"][-1].content


def test_every_specialist_prompt_forbids_false_denials_and_invented_attribution():
    for names in (("consultant", "migration_scope", "dbt_rules"), ("history",), ("repository",)):
        text = prompt(*names)
        assert "never say you cannot see, open or access it" in text
        assert "only partly loaded" in text
        assert "Never attribute to the user anything they did not say" in text
        assert "SECURITY RULES" in text and "untrusted data" in text


def test_long_file_reads_page_with_an_offset_and_short_files_are_unchanged():
    assert page_of("m.sql", "select 1") == "select 1"
    long = "a" * PAGE_CHARS + "TAIL"
    first = page_of("big.md", long)
    assert "offset=50000" in first and "TAIL" not in first and "truncated" in first
    second = page_of("big.md", long, PAGE_CHARS)
    assert second.endswith("TAIL") and "last page" in second
    assert "empty" in page_of("e.csv", "")


def test_get_file_content_offset_reaches_the_end_of_a_long_file():
    from test_gateway_and_tools import run_tool
    context = turn_context(FakeRegistry())
    context.workspace.files = {"big.md": "b" * (PAGE_CHARS + 10) + "END-OF-BIG"}
    message = run_tool(FILE_TOOLS, context, "get_file_content", file_name="big.md", offset=PAGE_CHARS)
    assert "END-OF-BIG" in message.content


def test_history_excerpts_and_oversized_turns_are_marked_not_silently_cut():
    excerpt = history_excerpt([{"role": "user", "content": "z" * 5000}], turns=1)
    assert "[excerpt: 2,000 more characters]" in excerpt[0]["content"]
    kept = history_messages([{"role": "user", "content": "q" * 300}], budget=100)
    assert len(kept) == 1 and "characters cut for space" in kept[0].content


def test_dropped_memories_are_acknowledged():
    context = turn_context(FakeRegistry())
    context.workspace.memories = [{"subject": f"s{i}", "text": "t" * 400} for i in range(10)]
    notes = formatting.memory_notes(context)
    assert "more standing instructions were not shown" in notes[0]


def test_brief_cut_point_plus_offset_read_reconstructs_the_screened_file():
    import guardrails
    from test_gateway_and_tools import run_tool
    original = "-- owner someone@example.com\n" + DESIGN
    agent = ConsultantAgent()
    agent.files_budget = 3_000
    context = turn_context(FakeRegistry())
    context.workspace.message = "explain it"
    context.workspace.files = {"design.md": original}
    human = agent.brief(context, {})[-1].content
    shown = human.split("<<<FILE design.md>>>\n", 1)[1].split("\n… [truncated here", 1)[0]
    assert len(shown) == 3_000 and "someone@example.com" not in shown
    rest = run_tool(FILE_TOOLS, context, "get_file_content", file_name="design.md", offset=3_000).content
    rest = rest.split("]\n", 1)[1]
    assert shown + rest == guardrails.check_outbound(original).text


def test_list_files_labels_are_exact_and_unparsed_reads_are_refused():
    from test_gateway_and_tools import run_tool
    label = "model.sql [v1; aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa]"
    context = turn_context(FakeRegistry())
    context.workspace.files = {label: "select 1", "book.xlsx": "PK\x03\x04\x14\x00raw"}
    listed = run_tool(FILE_TOOLS, context, "list_files").content
    assert f"Input files: {label}, book.xlsx\n" in listed
    raw = run_tool(FILE_TOOLS, context, "get_file_content", file_name="book.xlsx").content
    assert "could not be converted to text" in raw and "raw" not in raw.split("text")[-1]


def test_unloadable_files_take_no_share_of_the_budget():
    block = files_block({"book.xlsx": "PK\x03\x04" + "x" * 5000, "notes.md": "n" * 900}, budget=1_000)
    assert "n" * 900 in block and "Only partly loaded" not in block


def test_consultant_prompt_checks_false_premises_and_hides_internal_markers():
    from workflow.prompts import prompt
    text = prompt("consultant", "migration_scope", "dbt_rules")
    assert "wrong premise" in text and "Never invent a defect" in text
    assert "never mention markers" in text
