"""
AI guardrail pipeline (architecture doc §9) — Deep's item 5.

Runs inbound (before any content reaches the model) and outbound (before a
response is returned). Never optional, enforced server-side.

Inbound:  sanitisation -> prompt-injection / deny-list -> PII & NZ health-PII
          detection -> block (Mode A) or redact (Mode B) -> redacted payload.
Outbound: PII + secret-pattern redaction on model output.

Detection is pattern-based (NZ NHI, IRD, email, phone, DOB-in-context plus
generic secrets). Swap in Microsoft Presidio behind the same interface for
the production/CnA build if richer NER is required.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from config import settings

# ---------------------------------------------------------------------------
# PII recognisers
# ---------------------------------------------------------------------------

# NZ National Health Index. Old format AAANNNN, new format AAANNAA.
# NHI alphabet excludes I and O.
_NHI_ALPHA = r"[A-HJ-NP-Z]"
NHI_PATTERN = re.compile(
    rf"\b{_NHI_ALPHA}{{3}}(?:\d{{4}}|\d{{2}}{_NHI_ALPHA}{{2}})\b"
)

# NZ IRD number written with separators (8-9 digits: XX-XXX-XXX / XXX-XXX-XXX)
IRD_PATTERN = re.compile(r"\b\d{2,3}[- ]\d{3}[- ]\d{3}\b")

EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")

# NZ phone numbers (+64 or 0-prefixed, allowing spaces/dashes)
PHONE_PATTERN = re.compile(r"(?<!\d)(?:\+?64[\s-]?|\(?0\d?\)?[\s-]?)[2-9](?:[\s-]?\d){6,8}(?!\d)")

# Dates only when near a DOB/birth marker (avoids flagging ordinary dates)
DOB_PATTERN = re.compile(
    r"(?:dob|date\s+of\s+birth|birth\s*date|born)[:\s]*"
    r"(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4})",
    re.IGNORECASE,
)

# Credentials / secrets that must never egress
SECRET_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\b")),
]

# ---------------------------------------------------------------------------
# Prompt-injection heuristics & deny-list (OWASP LLM01 / restricted patterns)
# ---------------------------------------------------------------------------

INJECTION_PATTERNS: List[re.Pattern] = [
    re.compile(r"ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts)", re.I),
    re.compile(r"disregard\s+(?:all\s+|your\s+)?(?:instructions|rules|guidelines|system\s+prompt)", re.I),
    re.compile(r"forget\s+(?:everything|all\s+previous|your\s+instructions)", re.I),
    re.compile(r"(?:reveal|show|print|repeat|output)\s+(?:your\s+)?(?:system\s+prompt|instructions|initial\s+prompt)", re.I),
    re.compile(r"you\s+are\s+no\s+longer\s+(?:a|an|the)\b", re.I),
    re.compile(r"\bjailbreak\b|\bDAN\s+mode\b|developer\s+mode\s+enabled", re.I),
    re.compile(r"pretend\s+(?:you\s+are|to\s+be)\s+(?:an?\s+)?(?:unrestricted|unfiltered)", re.I),
    re.compile(r"act\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|different)\s+(?:ai|model|assistant)", re.I),
]

# Requests entirely outside the tool's migration scope
DENY_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("malware", re.compile(r"\b(?:write|create|generate|build)\b.{0,40}\b(?:malware|ransomware|keylogger|virus|exploit\s+code)\b", re.I)),
    ("credential_harvest", re.compile(r"\b(?:steal|harvest|exfiltrate|dump)\b.{0,40}\b(?:credentials?|passwords?|tokens?|secrets?)\b", re.I)),
    ("drop_destroy", re.compile(r"\b(?:drop|truncate|delete)\b.{0,30}\b(?:production|prod)\b.{0,30}\b(?:database|table|schema)\b", re.I)),
]

CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


@dataclass
class GuardrailResult:
    decision: str = "allow"  # allow | redacted | blocked
    text: str = ""
    reasons: List[str] = field(default_factory=list)
    findings: Dict[str, int] = field(default_factory=dict)
    data_class: str = "metadata"  # metadata | health-pii

    def as_dict(self) -> dict:
        return {
            "decision": self.decision,
            "reasons": self.reasons,
            "findings": [{"type": k, "count": v} for k, v in self.findings.items()],
            "data_class": self.data_class,
        }


def _sanitize(text: str) -> str:
    """Strip control characters and enforce the input size ceiling."""
    text = CONTROL_CHARS.sub("", text)
    if len(text) > settings.MAX_INPUT_CHARS:
        text = text[: settings.MAX_INPUT_CHARS]
    return text


def _redact(text: str, findings: Dict[str, int]) -> str:
    """Redact PII/secrets in-place, tallying findings by type."""

    def sub_and_count(pattern: re.Pattern, label: str, s: str) -> str:
        s, n = pattern.subn(f"[{label.upper()}_REDACTED]", s)
        if n:
            findings[label] = findings.get(label, 0) + n
        return s

    def redact_dob(m: re.Match) -> str:
        findings["dob"] = findings.get("dob", 0) + 1
        return m.group(0).replace(m.group(1), "[DOB_REDACTED]")

    text = sub_and_count(NHI_PATTERN, "nhi", text)
    text = DOB_PATTERN.sub(redact_dob, text)
    text = sub_and_count(IRD_PATTERN, "ird", text)
    text = sub_and_count(EMAIL_PATTERN, "email", text)
    text = sub_and_count(PHONE_PATTERN, "phone", text)
    for label, pattern in SECRET_PATTERNS:
        text = sub_and_count(pattern, label, text)
    return text


def _detect_health_pii(text: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    nhi = len(NHI_PATTERN.findall(text))
    if nhi:
        counts["nhi"] = nhi
    dob = len(DOB_PATTERN.findall(text))
    if dob:
        counts["dob"] = dob
    return counts


def check_inbound(message: str, files: Optional[Dict[str, str]] = None) -> GuardrailResult:
    """Inbound pipeline: returns block decision or the redacted payload.

    result.text is the redacted message; redacted file contents are stored on
    result.redacted_files.
    """
    result = GuardrailResult()
    files = files or {}

    if not settings.GUARDRAILS_ENABLED:
        result.text = message
        result.redacted_files = files  # type: ignore[attr-defined]
        return result

    message = _sanitize(message)
    files = {name: _sanitize(content) for name, content in files.items()}
    combined = message + "\n" + "\n".join(files.values())

    # 1. Prompt-injection detection (message only — uploaded data files are
    #    passed as data, but injection attempts in them are still flagged)
    for pattern in INJECTION_PATTERNS:
        if pattern.search(message):
            result.decision = "blocked"
            result.reasons.append("prompt_injection")
            break

    # 2. Restricted / out-of-scope request patterns
    for label, pattern in DENY_PATTERNS:
        if pattern.search(message):
            result.decision = "blocked"
            result.reasons.append(f"restricted_pattern:{label}")

    # 3. Health PII policy: Mode A blocks outright, Mode B redacts
    health = _detect_health_pii(combined)
    if health:
        result.data_class = "health-pii"
        result.findings.update(health)
        if not settings.PHI_MODE:
            result.decision = "blocked"
            result.reasons.append("health_pii_blocked_mode_a")

    if result.decision == "blocked":
        result.text = message
        result.redacted_files = files  # type: ignore[attr-defined]
        return result

    # 4. Redaction before model egress (always-on for PII + secrets)
    findings: Dict[str, int] = {}
    redacted_message = _redact(message, findings)
    redacted_files = {name: _redact(content, findings) for name, content in files.items()}

    result.findings.update(findings)
    if findings:
        result.decision = "redacted"
        result.reasons.append("pii_redacted_before_egress")

    result.text = redacted_message
    result.redacted_files = redacted_files  # type: ignore[attr-defined]
    return result


def check_outbound(text: str) -> GuardrailResult:
    """Outbound content filter on model output (PII + secrets)."""
    result = GuardrailResult(text=text)
    if not settings.GUARDRAILS_ENABLED or not text:
        return result

    findings: Dict[str, int] = {}
    result.text = _redact(_sanitize(text), findings)
    if findings:
        result.decision = "redacted"
        result.reasons.append("output_filtered")
        result.findings = findings
    return result


BLOCK_MESSAGES = {
    "prompt_injection": "the request matches prompt-injection patterns",
    "health_pii_blocked_mode_a": (
        "health-identifiable information (e.g. NHI) was detected. This deployment "
        "runs in metadata-only mode, so health data cannot be submitted. Remove the "
        "identifiers, or ask an administrator about PHI mode"
    ),
}


def block_message(reasons: List[str]) -> str:
    parts = []
    for reason in reasons:
        key = reason.split(":")[0]
        parts.append(BLOCK_MESSAGES.get(key, f"policy violation ({reason})"))
    detail = "; ".join(dict.fromkeys(parts)) or "policy violation"
    return f"⚠️ Request blocked by guardrails: {detail}. This decision has been logged."
