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


# --- Draft completeness audit ------------------------------------------------
# Deterministic findings about a draft that already parses. They never reject a
# draft (a rejected draft is not saved); they go back to the author as review
# defects and are disclosed to the user.

PLACEHOLDER_WORDS = {"TBD", "TBC", "TODO", "PLACEHOLDER", "FIXME", "XXX"}
EMPTY_JSON_TEXT = {"{}", "[]", ""}


def normalized_name(name: str) -> str:
    """'Practitioner ID', practitioner_id and practitionerId all compare equal."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _unwrap(node):
    while isinstance(node, (exp.Cast, exp.TryCast, exp.ToVariant, exp.Paren)):
        node = node.this
    return node


def _placeholder_kind(node) -> str:
    node = _unwrap(node)
    if isinstance(node, exp.ParseJSON) and isinstance(node.this, exp.Literal) \
            and node.this.is_string and node.this.this.strip() in EMPTY_JSON_TEXT:
        return "empty JSON"
    if isinstance(node, (exp.Struct, exp.JSONObject, exp.Array)) and not node.expressions:
        return "empty JSON"
    if isinstance(node, exp.Literal) and node.is_string and node.this.strip().upper() in PLACEHOLDER_WORDS:
        return f"'{node.this.strip()}' literal"
    if isinstance(node, exp.Null):
        return "NULL"
    return ""


def _object_pairs(node):
    """(key, value) pairs of OBJECT_CONSTRUCT / OBJECT_CONSTRUCT_KEEP_NULL."""
    node = _unwrap(node)
    if isinstance(node, (exp.Struct, exp.JSONObject)):
        for pair in node.expressions:
            if isinstance(pair, (exp.PropertyEQ, exp.JSONKeyValue)) and isinstance(pair.this, exp.Literal):
                yield pair.this.this, pair.expression


def _placeholders_in(path: str, node, found: dict) -> None:
    kind = _placeholder_kind(node)
    if kind:
        found.setdefault(path, kind)
        return
    for key, value in _object_pairs(node):
        _placeholders_in(f"{path}.{key}", value, found)


def _cte_names(tree) -> list[str]:
    return [cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE) if cte.alias_or_name]


def _unused_ctes(tree) -> list[str]:
    unused = []
    for cte in tree.find_all(exp.CTE):
        name = cte.alias_or_name.lower()
        used = any(table.name.lower() == name and not table.db
                   and table.find_ancestor(exp.CTE) is not cte
                   for table in tree.find_all(exp.Table))
        if not used:
            unused.append(name)
    return unused


def mapped_subkeys(column: str, mapping_text: str) -> list[str]:
    """Nested key paths the mapping gives under a column, e.g. 'Entitlement Data.approval.approvalType'."""
    words = [w for w in re.split(r"[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])", column) if w]
    if not words or not mapping_text:
        return []
    pattern = re.compile(r"(?<![A-Za-z0-9])" + r"[\s_-]*".join(map(re.escape, words))
                         + r"\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)", re.IGNORECASE)
    return list(dict.fromkeys(match.group(1) for match in pattern.finditer(mapping_text)))


PLACEHOLDER_REF = re.compile(r"^(placeholder|tbd)_", re.IGNORECASE)
SQL_BLOCK = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)


def _approved_names(entries: Iterable[str]) -> set[str]:
    """One entry may name several fields ('Entitlement Type, Practitioner ID and X') or a key path."""
    names = set()
    for entry in entries:
        for part in re.split(r",|;|/|\band\b|\n", entry or ""):
            for name in (part, part.strip().split(".")[-1]):
                if normalized_name(name):
                    names.add(normalized_name(name))
    return names


def _placeholder_map(tree) -> dict[str, str]:
    found: dict[str, str] = {}
    for select in tree.find_all(exp.Select):
        for projection in select.expressions:
            name = projection.alias_or_name
            if name and name != "*":
                _placeholders_in(name, projection.unalias(), found)
    return found


def _supplied_baseline(texts: Iterable[str], allowed_macros: set[str] | None) -> tuple[set[str], set[str]]:
    """Placeholder paths and unused CTEs already present in SQL the user supplied."""
    paths, unused = set(), set()
    for text in texts:
        for candidate in [text or "", *SQL_BLOCK.findall(text or "")]:
            if "select" not in candidate.lower():
                continue
            try:
                tree = parse_model(candidate.strip(), allowed_macros=allowed_macros)
            except Exception:
                continue
            paths |= {normalized_name(path) for path in _placeholder_map(tree)}
            unused |= set(_unused_ctes(tree))
    return paths, unused


def audit_draft(content: str, *, allowed_macros: set[str] | None = None, previous: str = "",
                approved_placeholders: Iterable[str] = (), mapping_text: str = "",
                supplied: Iterable[str] = ()) -> dict:
    """Deterministic findings about a draft that parses.

    Returns ``defects`` (back to the author), ``placeholders`` and ``nulls`` (shown
    to the user) and ``notices`` (shown to the reviewer only). Defects: empty
    JSON payloads and 'TBD'-style literals the user did not approve, any empty
    payload whose keys the mapping specifies, and unused CTEs. Placeholders and
    unused CTEs already in SQL the user ``supplied`` are disclosed, not defects:
    a narrow revision must preserve them. A bare NULL can be a real mapping, so
    it is listed separately and never a defect. A CTE the previous version used
    but this draft drops is a notice, since the user may have asked for it.
    """
    empty = {"defects": [], "placeholders": [], "nulls": [], "notices": []}
    try:
        tree = parse_model(content, allowed_macros=allowed_macros)
    except Exception:
        return empty
    allowed = _approved_names(approved_placeholders)
    baseline_paths, baseline_unused = _supplied_baseline(supplied, allowed_macros)
    defects, placeholders, nulls, notices = [], [], [], []
    for path, kind in _placeholder_map(tree).items():
        approved = any(normalized_name(part) in allowed for part in (path, *path.split(".")))
        inherited = normalized_name(path) in baseline_paths
        specified = mapped_subkeys(path, mapping_text) if kind == "empty JSON" else []
        if specified:
            placeholders.append(f"{path} ({kind})")
            defects.append(f"{path} is an empty JSON placeholder, but the mapping specifies its keys ("
                           + ", ".join(specified[:5]) + (", ..." if len(specified) > 5 else "")
                           + "); build it with nested OBJECT_CONSTRUCT from the mapped sources.")
        elif approved:
            placeholders.append(f"{path} ({kind}, placeholder you approved)")
        elif inherited:
            placeholders.append(f"{path} ({kind}, kept from your SQL)")
        elif kind == "NULL":
            nulls.append(path)
        else:
            placeholders.append(f"{path} ({kind})")
            defects.append(f"{path} is a {kind} placeholder, but the user did not ask for a placeholder there; "
                           "implement it from its mapped source.")
    for table in tree.find_all(exp.Table):
        if PLACEHOLDER_REF.match(table.name or ""):
            placeholders.append(f"ref {table.name} (placeholder model name)")
    for name in _unused_ctes(tree):
        if name not in baseline_unused:
            defects.append(f"CTE {name} is defined but never used; join it into the model where its fields are "
                           "mapped, or remove it if nothing needs it.")
    if previous:
        try:
            before = parse_model(previous, allowed_macros=allowed_macros)
            used_before = [name for name in _cte_names(before) if name not in _unused_ctes(before)]
        except Exception:
            used_before = []
        after = set(_cte_names(tree))
        notices += [f"CTE {name}, used by the previous version, is missing from this draft. It is a defect "
                    "unless the user asked for its removal or it was a pass-through (SELECT *) wrapper whose ref is "
                    "now joined directly." for name in used_before if name not in after]
    return {"defects": list(dict.fromkeys(defects)), "placeholders": list(dict.fromkeys(placeholders)),
            "nulls": nulls, "notices": notices}


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
