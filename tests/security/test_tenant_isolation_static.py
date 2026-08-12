"""Static verification of tenant-isolation.test.sql (live run needs Supabase;
see docs/release-checklist.md RLS row for the live command).

Asserts the script's own contract holds: it executes under real RLS as both
tenants (not as superuser), asserts zero cross-tenant visibility, covers the
core tenant-owned tables from migration 0002, and fails loudly via
ON_ERROR_STOP + do-block asserts.
"""
from __future__ import annotations

import re
from pathlib import Path

SQL = (Path(__file__).resolve().parent / "tenant-isolation.test.sql").read_text()


def test_runs_under_authenticated_role_as_both_tenants():
    assert "set local role authenticated" in SQL
    users = set(re.findall(r'"sub":\s*"([0-9a-f-]{36})"', SQL))
    assert len(users) >= 2, "must simulate at least two tenant users"


def test_asserts_cross_tenant_isolation():
    assert SQL.count("assert") >= 4, "needs explicit asserts, not eyeballing"
    assert "ON_ERROR_STOP=1" in SQL
    # negative-space checks: user B must not see/touch user A's rows
    assert re.search(r"assert\s+not\s+exists|assert\s+\w+\s*=\s*0|assert\s+not\s+found", SQL, re.I)


def test_covers_core_tenant_tables():
    for table in ("books", "chapters", "document_versions", "assets"):
        assert table in SQL, f"isolation test missing coverage for {table}"


def test_transactional_cleanup():
    assert re.search(r"^\s*begin\s*;", SQL, re.M) and re.search(r"^\s*rollback\s*;", SQL, re.M), \
        "must run in a rolled-back transaction so it is safe on any DB"
