"""
Data Migration Agent - Streamlit UI
Persistent chat threads with clean interface
"""

import streamlit as st
import os
from dotenv import load_dotenv

load_dotenv()

st.set_page_config(
    page_title="Migration Agent",
    page_icon="database",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# Clean styling
st.markdown("""
<style>
    #MainMenu, footer, header {visibility: hidden;}

    .main .block-container {
        padding: 1rem 2rem 6rem 2rem;
        max-width: 900px;
    }

    [data-testid="stChatMessage"] {
        padding: 1rem 1.5rem;
        border-radius: 12px;
        margin: 0.5rem 0;
    }

    [data-testid="stChatMessage"]:has([data-testid="chatAvatarIcon-user"]) {
        background: #2563eb;
        color: white;
        margin-left: 15%;
    }

    [data-testid="stChatMessage"]:has([data-testid="chatAvatarIcon-assistant"]) {
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        margin-right: 15%;
    }

    [data-testid="stChatInput"] {
        border-radius: 24px;
        border: 2px solid #e2e8f0;
    }

    .stButton > button {
        border-radius: 8px;
        font-weight: 500;
    }

    .stDownloadButton > button {
        background: #22c55e;
        color: white;
        border: none;
        border-radius: 8px;
    }

    [data-testid="stFileUploaderDropzone"] {
        background: #f8fafc;
        border: 2px dashed #cbd5e1;
        border-radius: 12px;
    }

    .upload-section {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 1rem;
        margin-bottom: 1rem;
    }
</style>
""", unsafe_allow_html=True)


# Session State
def init_session_state():
    defaults = {
        "messages": [],
        "uploaded_files": {},
        "generated_files": {},
        "output_folder": None,
        "processed_file_ids": set(),
        "api_key_set": bool(os.getenv("OPENAI_API_KEY")),
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value

init_session_state()


# Helpers
def read_uploaded_file(uploaded_file):
    if uploaded_file is None:
        return None
    try:
        uploaded_file.seek(0)
        content = uploaded_file.read()
        if isinstance(content, bytes):
            content = content.decode('utf-8')
        return content
    except:
        return None


def categorize_file(filename: str) -> str:
    name = filename.lower()
    if "template" in name or "additional" in name:
        return "template"
    elif "mapping" in name:
        return "mapping"
    elif "stg" in name:
        return "dbt_stg_add_info"
    elif "add_info" in name or "add-info" in name:
        return "dbt_add_info"
    return filename


def run_agent_query(message: str, file_contents: dict = None) -> str:
    try:
        from agent import run_agent, generated_outputs, get_output_folder_path
        response = run_agent(message, file_contents)

        for key, value in generated_outputs.items():
            if value is not None:
                st.session_state.generated_files[key] = value

        output_folder = get_output_folder_path()
        if output_folder:
            st.session_state.output_folder = output_folder

        return response
    except Exception as e:
        return f"Error: {str(e)}"


def clear_chat():
    try:
        from agent import reset_session
        reset_session()
    except:
        pass
    st.session_state.messages = []
    st.session_state.generated_files = {}
    st.session_state.output_folder = None


# Header
col1, col2 = st.columns([4, 1])
with col1:
    st.markdown("## Migration Agent")
with col2:
    if st.session_state.messages:
        if st.button("Clear Chat"):
            clear_chat()
            st.rerun()

# API Key check
if not st.session_state.api_key_set:
    api_key = st.text_input("OpenAI API Key", type="password", placeholder="sk-...")
    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key
        st.session_state.api_key_set = True
        st.rerun()
    st.stop()

# File Upload Section (main screen)
with st.expander("Upload Files", expanded=not st.session_state.uploaded_files):
    uploaded = st.file_uploader(
        "Drop template, mapping, ADD_INFO, and STG files here",
        type=["csv", "xlsx", "txt", "sql"],
        accept_multiple_files=True,
        label_visibility="collapsed"
    )

    if uploaded:
        for f in uploaded:
            file_id = f"{f.name}_{f.size}"
            if file_id not in st.session_state.processed_file_ids:
                content = read_uploaded_file(f)
                if content:
                    category = categorize_file(f.name)
                    st.session_state.uploaded_files[category] = content
                    st.session_state.processed_file_ids.add(file_id)

    if st.session_state.uploaded_files:
        st.caption(f"{len(st.session_state.uploaded_files)} file(s) loaded: {', '.join(st.session_state.uploaded_files.keys())}")

# Downloads Section
if st.session_state.generated_files:
    with st.expander("Download Generated Files", expanded=True):
        cols = st.columns(3)
        file_configs = [
            ("updated_dbt_add_info", "AMS_AI_DBT_ADD_INFO_updated.sql", "ADD_INFO"),
            ("updated_dbt_stg_add_info", "AMS_AI_DBT_STG_ADD_INFO_updated.sql", "STG"),
            ("analysis_report", "migration_analysis_report.txt", "Report"),
        ]
        for i, (key, filename, label) in enumerate(file_configs):
            if key in st.session_state.generated_files:
                with cols[i]:
                    st.download_button(
                        f"Download {label}",
                        st.session_state.generated_files[key],
                        filename,
                        use_container_width=True,
                        key=f"dl_{key}"
                    )

# Chat messages
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

# Chat input
if prompt := st.chat_input("Ask about your migration..."):
    st.session_state.messages.append({"role": "user", "content": prompt})

    with st.chat_message("user"):
        st.markdown(prompt)

    with st.chat_message("assistant"):
        with st.spinner("Thinking..."):
            files = st.session_state.uploaded_files or None
            response = run_agent_query(prompt, files)
        st.markdown(response)

    st.session_state.messages.append({"role": "assistant", "content": response})
    st.rerun()

# Empty state
if not st.session_state.messages:
    st.markdown("""
    <div style="text-align: center; padding: 2rem; color: #64748b;">
        <p>Upload your migration files above and start chatting.</p>
        <p style="font-size: 0.875rem;">
            Ask questions naturally - files are only generated when you request them.
        </p>
    </div>
    """, unsafe_allow_html=True)
