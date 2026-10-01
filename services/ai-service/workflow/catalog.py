"""Public capabilities, using the very same tool objects as the chat agents."""
from workflow.agents.conversational import ConsultantAgent, HistoryAgent, RepositoryAgent
from workflow.agents.impact.graph import EvidenceInvestigator
from workflow.agents.migration.analyst import RequirementsAnalyst


# Tool membership comes from the agents, not a second set of tool definitions.
TOOL_AGENTS = {
    "consultant": ConsultantAgent(),
    "history": HistoryAgent(),
    "repository": RepositoryAgent(),
    "requirements_analyst": RequirementsAnalyst(),
    "evidence_investigator": EvidenceInvestigator(),
}
TOOLS = {tool.name: tool for agent in TOOL_AGENTS.values() for tool in agent.spec.tools}
AGENTS = [
    ("router", "Head / Router", "Selects the specialist for each chat request.", "orchestration"),
    ("injection_guard", "Injection Guard", "Screens requests for prompt injection.", "safety"),
    ("grant_judge", "Source Grant Judge", "Checks whether an impact request is covered by confirmed sources.", "safety"),
    ("consultant", "Migration Consultant", "Answers migration questions using attached files and user memory.", "specialist"),
    ("history", "Chat History", "Searches saved chats and delivers previously saved files.", "specialist"),
    ("repository", "Repository", "Reads the caller's connected GitHub repositories.", "specialist"),
    ("migration", "Migration Pipeline", "Coordinates requirements, SQL authoring, validation and review.", "pipeline"),
    ("requirements_analyst", "Requirements Analyst", "Inspects migration inputs and requests missing requirements.", "specialist"),
    ("model_author", "Model Author", "Generates dbt SQL models from the agreed requirements.", "specialist"),
    ("model_reviewer", "Model Reviewer", "Reviews generated models against the validation checklist.", "specialist"),
    ("impact_analysis", "Impact Analysis Pipeline", "Coordinates source confirmation, evidence gathering and reporting.", "pipeline"),
    ("evidence_investigator", "Evidence Investigator", "Reads only the sources confirmed for the current analysis.", "specialist"),
    ("impact_reporter", "Impact Reporter", "Produces an evidence-backed impact report.", "specialist"),
    ("summarizer", "History Summarizer", "Condenses older turns for model context.", "support"),
    ("memory_capture", "Memory Capture", "Records standing instructions explicitly requested by the user.", "support"),
]


def agents_catalog():
    return [{"id": key, "name": name, "description": description, "kind": kind,
             "tools": [tool.name for tool in TOOL_AGENTS[key].spec.tools] if key in TOOL_AGENTS else [],
             "invocation": "chat"} for key, name, description, kind in AGENTS]


def tools_catalog():
    output = []
    for name, tool in TOOLS.items():
        schema = tool.tool_call_schema.model_json_schema()
        schema["additionalProperties"] = False
        requirements = ["An active account and a session owned by the caller."]
        if name in {"remember", "forget"}:
            requirements.append("Mutates the caller's standing instructions; confirm=true is required.")
        if name == "read_impact_evidence":
            requirements.append("Confirm sources through chat first; only the persisted grant is accepted.")
        if "github" in name:
            requirements.append("Repository reads require the caller's connected GitHub integration.")
        if name == "request_file_delivery":
            requirements.append("Returns owned file metadata and an authenticated download URL; does not create a chat message.")
        output.append({"name": name, "description": tool.description, "inputSchema": schema,
                       "agents": [key for key, agent in TOOL_AGENTS.items() if tool in agent.spec.tools],
                       "readOnly": name not in {"remember", "forget"}, "requirements": requirements})
    return output
