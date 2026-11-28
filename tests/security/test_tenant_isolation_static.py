"""Static coverage guards, not proof that the SQL executes or enforces RLS.
Run node tests/security/run-local-postgres.mjs for actual disposable PostgreSQL
execution; see docs/MIGRATION_INSTRUCTIONS.md for native Supabase validation.

Asserts the script's own contract holds: it executes under real RLS as both
tenants (not as superuser), asserts zero cross-tenant visibility, covers the
author-journey tenant tables, and fails loudly via ON_ERROR_STOP +
do-block asserts. It also guards the additive RLS hardening migration against
regressing into exposed SECURITY DEFINER helpers or implicit client grants.
"""
from __future__ import annotations

import re
from pathlib import Path

SQL = (Path(__file__).resolve().parent / "tenant-isolation.test.sql").read_text()
ROOT = Path(__file__).resolve().parents[2]
MIGRATION = next((ROOT / "supabase" / "migrations").glob("*_rls_tenant_hardening.sql"))
HARDENING_SQL = MIGRATION.read_text()


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
    for table in (
        "organizations",
        "organization_members",
        "books",
        "book_versions",
        "book_metadata",
        "chapters",
        "document_versions",
        "assets",
        "asset_versions",
        "editions",
    ):
        assert table in SQL, f"isolation test missing coverage for {table}"


def test_transactional_cleanup():
    assert re.search(r"^\s*begin\s*;", SQL, re.M) and re.search(r"^\s*rollback\s*;", SQL, re.M), \
        "fixtures must roll back; run only in a disposable or authorized database"


def test_hardening_enables_previously_unprotected_tenant_tables():
    for table in ("organizations", "organization_members", "comment_mentions", "stripe_events"):
        assert f"alter table public.{table} enable row level security;" in HARDENING_SQL


def test_hardening_uses_private_pinned_security_definer_helpers():
    assert "create schema if not exists private;" in HARDENING_SQL
    assert "revoke all on schema private from public;" in HARDENING_SQL

    for function in (
        "is_workspace_member(uuid)",
        "workspace_role(uuid)",
        "can_edit_workspace(uuid)",
        "can_approve_workspace(uuid)",
        "is_organization_member(uuid)",
        "can_manage_organization(uuid)",
        "is_community_member(uuid)",
        "community_is_visible(uuid)",
        "can_moderate_community(uuid)",
        "shares_active_workspace_with(uuid)",
    ):
        assert f"revoke all on function private.{function} from public;" in HARDENING_SQL
        assert f"grant execute on function private.{function} to authenticated;" in HARDENING_SQL

    assert HARDENING_SQL.count("security definer\nset search_path = ''") >= 8
    for function in (
        "can_edit_workspace(uuid)",
        "workspace_role(uuid)",
        "is_workspace_member(uuid)",
        "community_is_visible(uuid)",
        "is_community_member(uuid)",
    ):
        assert f"drop function if exists public.{function};" in HARDENING_SQL


def test_authenticated_policies_are_explicit_and_attribution_is_not_spoofable():
    assert "for all to authenticated" not in HARDENING_SQL.lower()
    for policy in (
        "books_insert",
        "document_versions_insert",
        "folders_insert",
        "assets_insert",
        "comments_insert",
        "tasks_insert",
        "approvals_insert",
        "community_posts_insert",
    ):
        assert f"create policy {policy}" in HARDENING_SQL

    assert HARDENING_SQL.count("created_by = (select auth.uid())") >= 5
    assert HARDENING_SQL.count("author_id = (select auth.uid())") >= 4
    assert "comment identity fields are immutable" in HARDENING_SQL
    assert "only the comment author may edit its body" in HARDENING_SQL
    assert "create policy asset_versions_update" in HARDENING_SQL
    assert "asset version identity is immutable" in HARDENING_SQL
    assert "grant select, insert, update on public.asset_versions to authenticated;" in HARDENING_SQL


def test_client_grants_are_least_privilege_and_sensitive_tables_stay_server_mediated():
    assert "revoke all on table public.organizations, public.organization_members," in HARDENING_SQL
    assert "public.publishing_profiles, public.publishing_jobs," in HARDENING_SQL
    assert "public.feature_flags, public.support_tickets, public.dead_letter_jobs" in HARDENING_SQL
    assert "grant select on public.plans to anon, authenticated;" in HARDENING_SQL
    assert "create policy asset_object_insert on storage.objects for insert to authenticated" in HARDENING_SQL
    assert "av.checksum = 'pending'" in HARDENING_SQL
    assert "grant select, insert on storage.objects to authenticated;" in HARDENING_SQL
