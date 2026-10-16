# Enterprise P0 Plan — RBAC · Audit · Distributed Locks · Instance Reclaim · Health Probes

Scope: the first enterprise-hardening milestone on top of the user's workspace /
upload-classification changes. Decisions below were confirmed with the owner:

- RBAC: **DB tables + management API** (not env-only).
- Audit: **PostgreSQL `audit_log` table + query API**; **change operations only**
  (login, upload, delete, graph writes, workspace lifecycle, user management —
  not read/query operations).
- Instance reclaim: **capacity cap + idle-timeout eviction** (busy-safe).

## Current-state facts (verified in code)

- Auth is JWT-based (`lightrag/api/auth.py`): `AUTH_ACCOUNTS` (`user:password` or
  `{bcrypt}` prefix), token carries `sub`/`role`/`exp`/`metadata`, `role` is
  currently hardcoded `"user"` at login; guest mode when no accounts configured.
- `get_combined_auth_dependency` authenticates but does **not** attach identity
  to the request; routes only get `Depends(combined_auth)` (bool gate).
- Workspace routing: `LIGHTRAG-WORKSPACE` header → `get_rag_dependency` /
  `get_doc_manager_dependency`; **no authorization** — any authenticated caller
  can reach any workspace and can `DELETE /workspaces/{name}` (physical
  `shutil.rmtree`).
- Background tasks (scan/enqueue/delete) are process-local `asyncio` tasks in
  `request.app.state.background_tasks`; no cross-worker exclusion.
- `WorkspaceManager.instances` grows unbounded (no cap, no eviction).
- `/health` exists (liveness + tiered diagnostics); no `/healthz`, no `/readyz`.
- Storage combo in the owner's `.env`: Redis KV · Milvus vectors · NetworkX
  graph · **PostgreSQL doc-status only** (so RBAC/audit tables live on the
  existing `PostgreSQLDB` instance).
- Frontend: `useAuthStore` parses `sub`/`role` from the JWT; `WorkspaceSelector`
  lists all workspaces with no permission filtering.

## Data model (new PostgreSQL tables)

```sql
LIGHTRAG_USERS(username TEXT PK, password_hash TEXT NOT NULL, role TEXT NOT NULL
  DEFAULT 'user', enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ)
-- role: admin | manager | viewer

LIGHTRAG_WORKSPACE_PERMISSIONS(username TEXT, workspace TEXT, access_level TEXT,
  created_at, updated_at, PK(username, workspace))
-- workspace: '' = default workspace; access_level: read | write | admin

LIGHTRAG_AUDIT_LOG(id BIGSERIAL PK, ts TIMESTAMPTZ DEFAULT now(), username TEXT,
  role TEXT, workspace TEXT, action TEXT, resource_type TEXT, resource_id TEXT,
  ip TEXT, user_agent TEXT, status TEXT, detail JSONB, request_id TEXT)
-- indexes on ts DESC, username, workspace, action
```

## Role / permission model

| Global role | Allowed operations |
|---|---|
| `admin` | everything incl. user management + workspace lifecycle |
| `manager` | read + write (upload / delete documents, graph edits) on authorized workspaces |
| `viewer` | read only (query, document list, graph read) on authorized workspaces |

Workspace authorization rules:
- `admin` → all workspaces, all operations.
- others → must hold a `LIGHTRAG_WORKSPACE_PERMISSIONS` row for the workspace
  (or `*` wildcard) whose `access_level` satisfies the operation class
  (write ops need `write|admin`).
- Guest mode (no users configured anywhere) keeps today's fully-open behavior.

Bootstrap: at startup, if `LIGHTRAG_USERS` is empty:
1. seed from `AUTH_ACCOUNTS` (each account becomes `role=admin`,
   `access_level=admin` on `'*'`) — keeps existing configs working; or
2. seed `INIT_ADMIN_USERNAME`/`INIT_ADMIN_PASSWORD` if set.
If neither is set, the system stays in guest mode (compatible).

Token: role snapshot signed at login (existing `role` claim);
workspace permission matrix is read from DB per request (TTL-cached ~30s) so
permission changes take effect without re-login.

API-key callers (`X-API-Key`) are treated as a service account with
`role=admin` (deployment-level key).

## Files

| File | Change |
|---|---|
| `lightrag/api/config.py` | env knobs: `RBAC_ENFORCE` (default off), `INIT_ADMIN_USERNAME/PASSWORD`, `AUDIT_LOG_ENABLED`, `WORKSPACE_MAX_INSTANCES` (8), `WORKSPACE_IDLE_TIMEOUT_SECONDS` (1800) |
| `lightrag/api/rbac.py` (new) | `RBACManager`: table access, seeding, user/perm CRUD, `check(account, action, workspace)`, TTL cache |
| `lightrag/api/audit.py` (new) | `AuditLogger`: PG insert + file fallback; `record()` helper |
| `lightrag/api/locks.py` (new) | `distributed_lock(namespace, workspace)`: PG advisory lock (session-level, dedicated connection), process-local fallback |
| `lightrag/api/auth.py` | login resolves role from DB (fallback AUTH_ACCOUNTS); AuthHandler keeps bcrypt verify |
| `lightrag/api/utils_api.py` | `combined_dependency` attaches identity to `request.state.account`; new `get_current_account` + `authorize(action)` dependency factories |
| `lightrag/api/routers/admin_routes.py` (new) | user CRUD + workspace-permission CRUD (admin-only) |
| `lightrag/api/routers/audit_routes.py` (new) | `GET /audit/logs` paged query (admin-only) |
| `lightrag/api/routers/workspace_routes.py` | list filtered by caller's permissions; create/delete require admin; delete under distributed lock |
| `lightrag/api/routers/document_routes.py` | upload/delete/scan gated to write level; audit hooks |
| `lightrag/api/routers/graph_routes.py` | read endpoints viewer+, write endpoints manager+; audit hooks |
| `lightrag/api/routers/query_routes.py` | viewer+ gate |
| `lightrag/api/workspace_manager.py` | LRU: cap + idle timeout + busy-safe eviction |
| `lightrag/api/lightrag_server.py` | seeding at startup, register new routers, `/healthz` `/readyz`, reclaim background task, audit logger on `app.state` |
| `lightrag/kg/postgres_impl.py` | migration chain: 3 new tables + `_migrate_create_enterprise_tables` |
| `env.example` | document the new knobs |
| frontend `api/lightrag.ts` | `WorkspaceInfo` + `access_level`; `getMyAccess()`; admin API client |
| frontend `WorkspaceSelector.tsx` | filter by access; hide create/delete unless permitted |
| frontend `features/admin/AdminUsersDialog.tsx` (new) | user + permission management |
| frontend `stores/state.ts` | expose `role` from token |
| frontend `SiteHeader.tsx` | show current user / role |
| frontend `locales/{en,zh}.json` | new strings |

## Verification

- Backend (actual, this machine): new `tests/api/rbac/` (22), `tests/api/audit/`
  (9), `tests/api/locks/` (6), `tests/api/workspace_manager/` (9) — all green.
  Full `tests/api` regression: **1330 passed, 16 failed, 14 skipped**; the 16
  failures are Windows-only platform constraints (symlink privilege 1314,
  `st_mode` 0o600, filenames containing `\x0b`, missing `fcntl`, POSIX absolute
  path semantics, and a `WHITELIST_PATHS` destructive-route test that requires
  `AUTH_ACCOUNTS`+`TOKEN_SECRET` env — verified equally red against pristine
  `HEAD` in a worktree, green with that env set). No P0 defect remains.
- Frontend (actual): `bunx tsc --noEmit` 0 errors; touched files lint clean;
  full `bun test` 616 pass / 20 fail, the 20 being a pre-existing
  `lightrag-stream.test.ts` axios-mock pollution (files pass alone) — not
  introduced by P0.
- Manual smoke (not run — requires real PG + running service): seed admin →
  login → create user with workspace perm → verify 403/200 matrix; audit rows
  visible via API; concurrent scan lock; `/healthz` `/readyz`; instance
  eviction log.
