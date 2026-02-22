"""
General Purpose File Processing Agent using OpenAI Agents SDK

This agent processes any type of file input and generates any type of
file or text output based on user instructions.

The Agents SDK uses the Responses API internally.
"""

import os
from datetime import datetime
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from agents import Agent, Runner, function_tool

# Load environment variables from .env file
load_dotenv()

# Get model from environment variable (default to gpt-5.2)
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.2")

# Base output directory
OUTPUT_BASE_DIR = Path(__file__).parent / "output"

# Storage for session
session_storage = {
    "files": {},
    "outputs": {},
    "output_folder": None,
}


def get_output_folder() -> Path:
    """Create and return a timestamped output folder."""
    if session_storage["output_folder"] is None:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_folder = OUTPUT_BASE_DIR / timestamp
        output_folder.mkdir(parents=True, exist_ok=True)
        session_storage["output_folder"] = output_folder
    return session_storage["output_folder"]


@function_tool
def read_file(file_name: str, content: str) -> str:
    """
    Read and store a file for processing.

    Args:
        file_name: Name of the file being uploaded.
        content: The content of the file.
    """
    session_storage["files"][file_name] = content
    return f"File '{file_name}' loaded ({len(content)} characters)."


@function_tool
def generate_output(file_name: str, content: str) -> str:
    """
    Generate and save an output file.

    Args:
        file_name: Name for the output file.
        content: The content to write to the file.
    """
    output_folder = get_output_folder()
    file_path = output_folder / file_name
    file_path.write_text(content)
    session_storage["outputs"][file_name] = content
    return f"File saved to: {file_path}"


@function_tool
def list_files() -> str:
    """List all loaded input files and generated outputs."""
    inputs = list(session_storage["files"].keys())
    outputs = list(session_storage["outputs"].keys())

    result = "Input files: " + (", ".join(inputs) if inputs else "None")
    result += "\nOutput files: " + (", ".join(outputs) if outputs else "None")

    if session_storage["output_folder"]:
        result += f"\nOutput folder: {session_storage['output_folder']}"

    return result


@function_tool
def get_file_content(file_name: str) -> str:
    """
    Get the content of a loaded or generated file.

    Args:
        file_name: Name of the file to retrieve.
    """
    if file_name in session_storage["files"]:
        return session_storage["files"][file_name]
    if file_name in session_storage["outputs"]:
        return session_storage["outputs"][file_name]
    return f"File '{file_name}' not found."


INSTRUCTIONS = """You are a helpful file processing assistant.

You can:
- Read and process any type of file (CSV, JSON, SQL, XML, text, code, etc.)
- Generate any type of output file or text based on user instructions
- Transform, analyze, convert, or modify file contents as requested

When the user uploads a file, use read_file to store it.
When the user asks you to generate output, use generate_output to save it.
Use list_files to show what files are in the session.
Use get_file_content to retrieve file contents.

Follow user instructions precisely and generate the requested output."""


def create_agent() -> Agent:
    """Create and configure the agent."""
    return Agent(
        name="FileProcessingAgent",
        instructions=INSTRUCTIONS,
        model=OPENAI_MODEL,
        tools=[
            read_file,
            generate_output,
            list_files,
            get_file_content,
        ],
    )


def run_agent(user_message: str, file_contents: Optional[dict] = None) -> str:
    """
    Run the agent with user message and optional file contents.

    Args:
        user_message: The user's message/instruction.
        file_contents: Optional dict with file names as keys and content as values.

    Returns:
        Agent's response.
    """
    agent = create_agent()

    full_message = user_message
    if file_contents:
        for file_name, content in file_contents.items():
            full_message += f"\n\n[Uploaded {file_name}]:\n{content}"

    result = Runner.run_sync(agent, full_message)
    return result.final_output


def get_downloadable_files() -> dict:
    """Return all generated files that are ready for download."""
    return session_storage["outputs"].copy()


def get_output_folder_path() -> Optional[str]:
    """Return the current output folder path."""
    if session_storage["output_folder"]:
        return str(session_storage["output_folder"])
    return None


def reset_session():
    """Reset the session."""
    global session_storage
    session_storage = {
        "files": {},
        "outputs": {},
        "output_folder": None,
    }
