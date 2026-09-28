"""Static draft checks. Parsing is never represented as target database validation."""
import ast
import hashlib
import re
from collections.abc import Iterable
import sqlglot
from sqlglot import exp


class ValidationError(ValueError):
    pass


TEMPLATE_EXPRESSION = re.compile(r"\{\{(.*?)\}\}", re.S)
FORBIDDEN_MACROS = {"run_query", "statement", "load_result", "store_result", "log", "print",
                    "debug", "return", "config", "ref", "source", "exceptions"}
# SQLGlot represents the two-argument overload as Anonymous, although this is
# a Snowflake built-in: https://docs.snowflake.com/en/sql-reference/functions/to_timestamp
SNOWFLAKE_TIMESTAMP_FUNCTIONS = {"TO_TIMESTAMP_NTZ", "TO_TIMESTAMP_LTZ", "TO_TIMESTAMP_TZ"}


def unknown_functions(tree):
    return [node for node in tree.find_all(exp.Anonymous)
            if node.name.upper() not in SNOWFLAKE_TIMESTAMP_FUNCTIONS or isinstance(node.parent, exp.Dot)]


def literal_macro(expression: str) -> str | None:
    """Canonical literal scalar call, never evaluated or imported."""
    try:
        node = ast.parse(expression.strip(), mode="eval").body
        if (not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name)
                or node.func.id.startswith("_") or node.func.id in FORBIDDEN_MACROS
                or node.keywords or not node.args):
            return None
        if not all(isinstance(arg, ast.Constant) and isinstance(arg.value, (str, int, float, bool))
                   for arg in node.args):
            return None
        return ast.dump(node)
    except (SyntaxError, ValueError):
        return None


def supplied_macros(sources: Iterable[str]) -> set[str]:
    """Only exact calls already present in the supplied model may be preserved."""
    return {key for source in sources for expression in TEMPLATE_EXPRESSION.findall(source)
            if (key := literal_macro(expression)) is not None}


def compile_model(content: str, *, allowed_macros: set[str] | None = None,
                  deferred: set[str] | None = None) -> str:
    # Interpret only literal dbt ref/source/config calls; never execute uploaded Jinja.
    def render(match):
        try:
            node = ast.parse(match.group(1).strip(), mode="eval").body
        except SyntaxError as exc:
            raise ValidationError("Invalid template expression") from exc
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            raise ValidationError("Only literal dbt ref, source and config calls are supported")
        if node.func.id == "config":
            if node.args or any(k.arg not in ("materialized", "unique_key", "schema", "tags", "alias", "cluster_by") for k in node.keywords):
                raise ValidationError("Unsupported dbt configuration; hooks are prohibited")
            for k in node.keywords:
                ast.literal_eval(k.value)
            return ""
        if node.func.id not in ("ref", "source"):
            key = literal_macro(match.group(1))
            if key and key in (allowed_macros or set()):
                if deferred is not None:
                    deferred.add(node.func.id)
                # A SQL-shaped placeholder checks the surrounding SELECT only.
                # Never render Jinja, read an env var or execute a custom macro.
                return "__dbt_expression__"
            raise ValidationError("Unsupported dbt macro; only exact literal calls from the supplied model can be preserved")
        if node.keywords:
            raise ValidationError("Unsupported dbt macro")
        args = [ast.literal_eval(a) for a in node.args]
        if len(args) != (1 if node.func.id == "ref" else 2) or any(not isinstance(a, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", a) for a in args):
            raise ValidationError("Invalid model reference")
        return ".".join('"' + a + '"' for a in args)
    compiled = TEMPLATE_EXPRESSION.sub(render, content)
    if any(marker in compiled for marker in ("{%", "{#", "{{")):
        raise ValidationError("Unsupported template syntax requires a target dbt validation run")
    return compiled


def parse_model(content: str, *, allowed_macros: set[str] | None = None, deferred: set[str] | None = None):
    compiled = compile_model(content, allowed_macros=allowed_macros, deferred=deferred)
    trees = sqlglot.parse(compiled, read="snowflake", error_level=sqlglot.ErrorLevel.RAISE)
    if len(trees) != 1 or not isinstance(trees[0], exp.Query):
        raise ValidationError("Models must contain one read-only SELECT query")
    tree = trees[0]
    denied = (exp.DDL, exp.DML, exp.Command, exp.Into)
    if any(isinstance(node, denied) for node in tree.walk()):
        raise ValidationError("Data modification and command statements are prohibited")
    # Unknown functions can invoke externally configured UDFs. Require explicit review.
    if unknown_functions(tree):
        raise ValidationError("Custom functions require separate review")
    return tree


def rejection_reason(content: str, *, allowed_macros: set[str] | None = None) -> str:
    """An actionable reason for the author and user, without echoing SQL values."""
    try:
        tree = parse_model(content, allowed_macros=allowed_macros)
    except ValidationError as exc:
        if str(exc) == "Custom functions require separate review":
            return "Unrecognised functions (use standard Snowflake functions only): " + ", ".join(
                sorted({node.name for node in unknown_functions(sqlglot.parse_one(
                    compile_model(content, allowed_macros=allowed_macros), read="snowflake"))}))
        return str(exc)
    except sqlglot.errors.ParseError as exc:
        first = exc.errors[0] if exc.errors else {}
        description = str(first.get("description") or "syntax error").split(" but got")[0]
        return f"SQL does not parse near line {first.get('line', '?')}, column {first.get('col', '?')}: {description}"
    except Exception:
        return "SQL could not be parsed as one read-only Snowflake SELECT"
    return "" if tree is not None else "SQL could not be parsed"


def validate_output(filename: str, content: str, *, sources: Iterable[str] = ()) -> dict:
    report = {"sha256": hashlib.sha256(content.encode()).hexdigest(), "status": "draft",
              "static_checks": "not_applicable", "target_database_test": "required",
              "mapping_test": "required", "human_approval": "required", "errors": []}
    if filename.lower().endswith(".sql"):
        allowed = supplied_macros(sources)
        deferred: set[str] = set()
        try:
            tree = parse_model(content, allowed_macros=allowed, deferred=deferred)
            report.update(static_checks="partial" if deferred else "passed", columns=tree.named_selects)
            if deferred:
                report.update(deferred_macros=sorted(deferred), dbt_compile="required",
                              warnings=["The surrounding SQL was parsed using placeholders for supplied dbt macros. "
                                        "Macro expansion has not been validated; run dbt compile and review in the target project."])
        except Exception:
            report.update(status="rejected", static_checks="failed", errors=[rejection_reason(content, allowed_macros=allowed)])
    return report
