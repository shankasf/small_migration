"""Synthetic fixture tests in a separate, bounded SQLite process; no target credentials."""
import json
import sqlite3
import re
import sys
from validation import parse_model
from sqlglot import ErrorLevel


def run_fixture(content: str, fixture: dict) -> dict:
    if len(json.dumps(fixture)) > 200000:
        raise ValueError('Fixture exceeds size limit')
    if not fixture.get('tables') or not isinstance(fixture.get('expected_rows'), list) or not fixture.get('expected_columns'):
        raise ValueError('Tables, expected columns and expected rows are required')
    tree = parse_model(content)
    sql = tree.sql(dialect='sqlite', unsupported_level=ErrorLevel.RAISE)
    db = sqlite3.connect(':memory:')
    try:
        db.enable_load_extension(False)
        for name, table in fixture['tables'].items():
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                raise ValueError('Fixture table names must be simple identifiers')
            columns = table['columns']
            if not columns or len(table['rows']) > 1000:
                raise ValueError('Invalid fixture shape')
            if any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) or v not in ('TEXT', 'INTEGER', 'REAL') for k, v in columns.items()):
                raise ValueError('Invalid fixture columns')
            db.execute(f'CREATE TABLE "{name}" (' + ','.join(f'"{k}" {v}' for k,v in columns.items()) + ')')
            db.executemany(f'INSERT INTO "{name}" VALUES (' + ','.join('?' for _ in columns) + ')', table['rows'])
        db.commit()
        functions = {'abs', 'coalesce', 'count', 'ifnull', 'length', 'lower', 'ltrim', 'max', 'min', 'nullif', 'replace', 'round', 'rtrim', 'substr', 'substring', 'sum', 'trim', 'upper'}
        def authorize(action, arg1, arg2, _db, _trigger):
            if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ):
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and str(arg2).lower() in functions:
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        db.set_authorizer(authorize)
        ticks = 0
        def interrupt():
            nonlocal ticks
            ticks += 1
            return 1 if ticks > 10000 else 0
        db.set_progress_handler(interrupt, 1000)
        cursor = db.execute(sql)
        rows = cursor.fetchmany(1001)
        columns = [d[0] for d in cursor.description]
        passed = columns == fixture['expected_columns'] and [list(row) for row in rows] == fixture['expected_rows']
        return {'status': 'passed' if passed else 'failed', 'engine': 'sqlite-synthetic',
                'columns_match': columns == fixture['expected_columns'], 'rows_match': [list(r) for r in rows] == fixture['expected_rows'],
                'target_database_test': 'still_required'}
    finally:
        db.close()

if __name__ == '__main__':
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
    try:
        request = json.load(sys.stdin)
        print(json.dumps(run_fixture(request['content'], request['fixture'])))
    except Exception:
        print(json.dumps({'status': 'failed', 'reason': 'Fixture validation failed; check SQL, fixture and supported dialect'}))
        sys.exit(1)
