"""LangGraph agent runtime for the migration assistant.

One turn of chat is one run of the turn graph (``orchestrator.build_turn_graph``).
Every step in the graph is one of four kinds, following LangGraph's
"Thinking in LangGraph" method:

- LLM steps      understand, analyse, generate or decide (the ten agents)
- Data steps     read from the backend, uploads or static validation
- Action steps   guardrails, publishing files, composing the reply
- User input     ``interrupt()`` — the graph pauses until the user replies

Per-turn request data (identity, files, history, gateway, logger) travels in the
runtime context and is never checkpointed. Checkpointed state holds only the
small, screened workflow facts a later turn needs.
"""
