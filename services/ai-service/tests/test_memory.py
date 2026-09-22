"""Both halves of LangGraph memory: the per-user store, and the running summary.

The store has no expiry, so these tests pin the properties that keep it usable
years in: one subject is one memory, recall is capped, and a memory belongs to
exactly one user.
"""
import asyncio

import pytest
from langgraph.store.memory import InMemoryStore

from fakes import FakeRegistry, call
from test_turn_graph import Harness, route
from workflow.memory import subject_key, user_namespace


def run(coro):
    return asyncio.run(coro)


def consulting(store, *replies):
    harness = Harness(store=store)
    harness.models.script("router", route("consult"))
    harness.models.script("consultant", *replies)
    return harness


def stored(store, actor="alice"):
    return {item.value["subject"]: item.value["text"] for item in run(store.asearch(user_namespace(actor)))}


def test_what_the_user_asks_to_remember_outlives_the_chat():
    store = InMemoryStore()
    harness = consulting(store, call("remember", subject="target warehouse",
                                     fact="Always target Snowflake, schema RAW_VAULT."),
                         "Noted — I'll target Snowflake RAW_VAULT from now on.")
    harness.turn("from now on we always target snowflake, schema RAW_VAULT. remember that")
    assert stored(store) == {"target warehouse": "Always target Snowflake, schema RAW_VAULT."}

    # A new chat is a new thread, but the instruction is still there and reaches the prompt.
    recalling = consulting(store, "Yes — Snowflake, schema RAW_VAULT.")
    recalling.turn("which warehouse are we targeting?", session="chat-2")
    system = recalling.models.requests("consultant")[0]["messages"][0].content
    assert "They are preferences for how the work is done" in system and "RAW_VAULT" in system


def test_restating_a_preference_replaces_it_rather_than_piling_up():
    store = InMemoryStore()
    harness = consulting(store, call("remember", subject="target warehouse", fact="Target Snowflake."),
                         "Noted.", call("remember", subject="Target Warehouse",
                                        fact="Target Databricks from now on."), "Updated.")
    harness.models.script("router", route("consult"))
    harness.turn("remember we target snowflake")
    harness.turn("actually we moved to databricks, remember that instead")
    assert stored(store) == {"Target Warehouse": "Target Databricks from now on."}
    assert len(run(store.asearch(user_namespace("alice")))) == 1


def test_one_user_never_sees_another_users_memory():
    store = InMemoryStore()
    consulting(store, call("remember", subject="naming", fact="Prefix staging models with stg_."),
               "Noted.").turn("remember: prefix staging models with stg_")
    other = consulting(store, "I have no standing instructions for you.")
    other.turn("what do you remember about me?", actor="mallory")
    assert "Prefix staging models" not in other.models.requests("consultant")[0]["messages"][0].content
    assert not stored(store, actor="mallory")


def test_a_memory_is_capped_and_never_stores_secrets():
    store = InMemoryStore()
    harness = consulting(store,
                         call("remember", subject="deploy key", fact="Use token ghp_" + "a" * 36),
                         call("remember", subject="essay", fact="x" * 5000),
                         "Saved what I could.")
    harness.turn("remember these")
    saved = stored(store)
    assert "ghp_" not in saved.get("deploy key", "")
    assert "essay" not in saved


def test_a_turn_cannot_fill_the_store():
    store = InMemoryStore()
    facts = [call("remember", subject=f"rule {n}", fact=f"Rule number {n}.") for n in range(6)]
    harness = consulting(store, *facts, "Saved.")
    harness.turn("remember all of these rules")
    assert len(stored(store)) == 3  # MEMORY_WRITES_PER_TURN


def test_a_small_memory_is_read_whole_and_a_large_one_is_ranked():
    """Ranking (and its embedding call) only happens once memory outgrows the prompt budget."""
    queries: list[dict] = []

    class WatchingStore(InMemoryStore):
        async def asearch(self, namespace, **kwargs):
            queries.append(kwargs)
            return await super().asearch(namespace, **kwargs)

    store = WatchingStore()
    for number in range(3):
        run(store.aput(user_namespace("alice"), subject_key(f"rule {number}"),
                       {"subject": f"rule {number}", "text": f"Rule {number}."}))
    consulting(store, "Answer.").turn("what are my rules?")
    assert [bool(call.get("query")) for call in queries] == [False]

    queries.clear()
    for number in range(3, 9):
        run(store.aput(user_namespace("alice"), subject_key(f"rule {number}"),
                       {"subject": f"rule {number}", "text": f"Rule {number}."}))
    consulting(store, "Answer.").turn("what are my rules?")
    assert [bool(call.get("query")) for call in queries] == [False, True]


def test_forget_removes_a_standing_instruction():
    store = InMemoryStore()
    run(store.aput(user_namespace("alice"), subject_key("target warehouse"),
                   {"subject": "target warehouse", "text": "Target Snowflake."}))
    harness = consulting(store, call("forget", subject="target warehouse"), "Forgotten.")
    harness.turn("forget what you know about our target warehouse")
    assert not stored(store)


def test_a_store_outage_does_not_fail_the_turn():
    class BrokenStore(InMemoryStore):
        async def asearch(self, *args, **kwargs):
            raise RuntimeError("DynamoDB is unavailable")

    harness = consulting(BrokenStore(), "IFNULL replaces nulls; NULLIF makes them.")
    result = harness.turn("IFNULL or NULLIF?")
    assert "IFNULL" in result.response
    assert "They are preferences for how the work is done" not in \
        harness.models.requests("consultant")[0]["messages"][0].content


def test_no_store_configured_is_simply_no_memory():
    harness = consulting(None, call("remember", subject="naming", fact="Prefix with stg_."),
                         "I can't save that in this deployment.")
    assert harness.turn("remember: prefix with stg_").response


def test_a_plain_request_to_remember_is_kept_even_if_the_agent_ignores_its_tool():
    """The usual failure: a warm reply, no tool call, nothing actually saved."""
    store = InMemoryStore()
    harness = consulting(store, "Of course — I'll keep that in mind for your future chats.")
    harness.models.script("summarizer", "SUBJECT: target warehouse\n"
                                        "INSTRUCTION: Always target the Snowflake schema RAW_VAULT.")
    result = harness.turn("From now on always target the Snowflake schema RAW_VAULT. Remember that.")
    assert stored(store) == {"target warehouse": "Always target the Snowflake schema RAW_VAULT."}
    assert "Saved for your future chats" in result.response


def test_the_capture_step_stays_out_of_the_way_when_the_agent_saved_it():
    store = InMemoryStore()
    harness = consulting(store, call("remember", subject="model naming", fact="Prefix staging models with stg_."),
                         "Saved — staging models will be prefixed stg_.")
    harness.turn("from now on always prefix staging models with stg_, remember that")
    assert stored(store) == {"model naming": "Prefix staging models with stg_."}
    assert not harness.models.requests("summarizer")


@pytest.mark.parametrize("reply,expected", [
    ("SUBJECT: target warehouse\nINSTRUCTION: Always target Snowflake.", ("target warehouse", "Always target Snowflake.")),
    ("subject: naming\n\ninstruction:  Prefix with stg_.  ", ("naming", "Prefix with stg_.")),
    ("NONE", ("", "")),
    ("I think they meant Snowflake?", ("", "")),
    ("SUBJECT: \nINSTRUCTION: something", ("", "")),
])
def test_only_an_exact_capture_is_saved(reply, expected):
    from workflow.agents.memorist import parse_capture
    assert parse_capture(reply) == expected


def test_an_ordinary_question_is_never_captured():
    store = InMemoryStore()
    harness = consulting(store, "IFNULL replaces nulls; NULLIF makes them.")
    harness.turn("IFNULL or NULLIF for this column?")
    assert not stored(store) and not harness.models.requests("summarizer")


def test_the_capture_step_refuses_what_is_not_durable():
    store = InMemoryStore()
    harness = consulting(store, "Casting to NUMBER(38,2) is safe here.")
    harness.models.script("summarizer", "NONE")
    result = harness.turn("For this question only, remember we are on Snowflake: is NUMBER(38,2) safe?")
    assert not stored(store) and "Saved for your future chats" not in result.response


# --- short-term: the running summary -----------------------------------------

def long_history(turns: int, marker: str = "") -> list[dict[str, str]]:
    """A chat well past the summarisation threshold."""
    history = []
    for number in range(turns):
        history.append({"role": "user", "content": f"Turn {number}: " + "please review this mapping. " * 200})
        history.append({"role": "assistant", "content": f"Answer {number}: " + "here is the review. " * 200})
    if marker:
        history.insert(0, {"role": "user", "content": marker})
    return history


def test_a_long_chat_is_summarised_once_and_the_summary_is_reused():
    harness = Harness()
    harness.models.script("router", route("consult"), route("consult"))
    harness.models.script("summarizer", "The user is migrating policy models and approved stg_policies.")
    harness.models.script("consultant", "First answer.", "Second answer.")
    harness.turn("what did we decide?", history=long_history(12))

    system = harness.models.requests("consultant")[0]["messages"][0].content
    assert "Summary of the earlier part of this chat" in system and "stg_policies" in system
    state = harness.state()
    assert state["summary"].startswith("The user is migrating")
    assert state["summarized_upto"] > 0

    # The next turn reuses it: the summariser is not called again.
    harness.turn("and the naming?", history=long_history(12))
    assert len(harness.models.requests("summarizer")) == 1


def test_a_short_chat_is_never_summarised():
    harness = Harness()
    harness.models.script("router", route("consult"))
    harness.models.script("consultant", "Short answer.")
    harness.turn("hello", history=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}])
    assert not harness.models.requests("summarizer")
    assert not harness.state().get("summary")


def test_the_oldest_turns_leave_the_prompt_but_the_recent_ones_stay():
    harness = Harness()
    harness.models.script("router", route("consult"))
    harness.models.script("summarizer", "Earlier: the user chose RAW_VAULT.")
    harness.models.script("consultant", "Answer.")
    history = long_history(12, marker="ANCIENT-MARKER: the very first message")
    history.append({"role": "user", "content": "RECENT-MARKER: the last thing said"})
    harness.turn("carry on", history=history)
    messages = harness.models.requests("consultant")[0]["messages"]
    transcript = "\n".join(str(message.content) for message in messages)
    assert "RECENT-MARKER" in transcript and "ANCIENT-MARKER" not in transcript
    assert "Earlier: the user chose RAW_VAULT." in str(messages[0].content)


def test_a_history_shorter_than_the_summary_covers_is_rebuilt():
    """A chat whose messages were removed must not keep a summary that reaches past its end."""
    harness = Harness()
    harness.models.script("router", route("consult"), route("consult"))
    harness.models.script("summarizer", "First summary.", "Rebuilt summary.")
    harness.models.script("consultant", "Answer.", "Answer.")
    harness.turn("first", history=long_history(12))
    assert harness.state()["summarized_upto"] > 2
    # The same thread, now with a much shorter conversation than was summarised.
    harness.turn("second", history=[{"role": "user", "content": "hi"}])
    assert harness.state() == {**harness.state(), "summary": "", "summarized_upto": 0}
    assert len(harness.models.requests("summarizer")) == 1


@pytest.mark.parametrize("subject,same", [("target warehouse", "Target Warehouse"),
                                          ("naming rules", "  naming   RULES  ")])
def test_one_subject_is_one_key_however_it_is_written(subject, same):
    assert subject_key(subject) == subject_key(same)
    assert subject_key(subject) != subject_key("something else")
