"""Static draft checks. Parsing is never represented as target database validation."""
import ast
import hashlib
import re
import sqlglot
from sqlglot import exp


class ValidationError(ValueError):
    pass


def compile_model(content: str) -> str:
    # Interpret only literal dbt ref/source/config calls; never execute uploaded Jinja.
    def render(match):
        try:
            node = ast.parse(match.group(1).strip(), mode="eval").body
        except SyntaxError as exc:
            raise ValidationError("Invalid template expression") from exc
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            raise ValidationError("Only literal dbt ref, source and config calls are supported")
        if node.func.id == "config":
            if node.args or any(k.arg not in ("materialized", "unique_key", "schema", "tags", "alias") for k in node.keywords):
                raise ValidationError("Unsupported dbt configuration; hooks are prohibited")
            for k in node.keywords:
                ast.literal_eval(k.value)
            return ""
        if node.keywords or node.func.id not in ("ref", "source"):
            raise ValidationError("Unsupported dbt macro")
        args = [ast.literal_eval(a) for a in node.args]
        if len(args) != (1 if node.func.id == "ref" else 2) or any(not isinstance(a, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", a) for a in args):
            raise ValidationError("Invalid model reference")
        return ".".join('"' + a + '"' for a in args)
    compiled = re.sub(r"\{\{(.*?)\}\}", render, content, flags=re.S)
    if any(marker in compiled for marker in ("{%", "{#", "{{")):
        raise ValidationError("Unsupported template syntax requires a target dbt validation run")
    return compiled


def parse_model(content: str):
    compiled = compile_model(content)
    trees = sqlglot.parse(compiled, read="snowflake", error_level=sqlglot.ErrorLevel.RAISE)
    if len(trees) != 1 or not isinstance(trees[0], exp.Query):
        raise ValidationError("Models must contain one read-only SELECT query")
    tree = trees[0]
    denied = (exp.DDL, exp.DML, exp.Command, exp.Into)
    if any(isinstance(node, denied) for node in tree.walk()):
        raise ValidationError("Data modification and command statements are prohibited")
    # Unknown functions can invoke externally configured UDFs. Require explicit review.
    if any(isinstance(node, exp.Anonymous) for node in tree.walk()):
        raise ValidationError("Custom functions require separate review")
    return tree


def validate_output(filename: str, content: str) -> dict:
    report = {"sha256": hashlib.sha256(content.encode()).hexdigest(), "status": "draft",
              "static_checks": "not_applicable", "target_database_test": "required",
              "mapping_test": "required", "human_approval": "required", "errors": []}
    if filename.lower().endswith(".sql"):
        try:
            tree = parse_model(content)
            report.update(static_checks="passed", columns=tree.named_selects)
        except Exception:
            report.update(status="rejected", static_checks="failed", errors=["SQL is invalid or contains unsupported/unsafe SQL or dbt constructs"])
    return report
