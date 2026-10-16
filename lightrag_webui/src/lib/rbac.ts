/**
 * RBAC permission helpers for the WebUI.
 *
 * Server-side enforcement happens in lightrag/api (RBAC_ENFORCE). These
 * helpers mirror the server's role rules for UI affordances only — hiding
 * buttons a viewer cannot use, showing role badges — and deliberately stay
 * permissive when no role is known (auth disabled / guest mode), preserving
 * the original open behavior.
 */

export type UserRole = 'admin' | 'manager' | 'viewer' | 'guest' | null

/** Accepts any role-typed value from the auth store (string | null). */
export type MaybeRole = UserRole | string | null | undefined

const normalizeRole = (role: MaybeRole): UserRole => {
  if (role === 'admin' || role === 'manager' || role === 'viewer' || role === 'guest') {
    return role
  }
  return null
}

/** Read access: every authenticated identity can read (roles + per-workspace grants). */

/**
 * Write access to a workspace's documents/graph (mirrors the server rules):
 * - admin: write everywhere
 * - manager / viewer: only on workspaces granted write/admin
 * - guest / unknown: open (original behavior; the server still enforces)
 */
export const canWrite = (
  role: MaybeRole,
  accessLevel?: string | null | undefined
): boolean => {
  const normalized = normalizeRole(role)
  if (normalized === 'admin') return true
  if (normalized === 'manager' || normalized === 'viewer') {
    return accessLevel === 'write' || accessLevel === 'admin'
  }
  // guest / auth-disabled / unknown role: keep the original open behavior.
  return true
}

/**
 * Create/delete named workspaces. Server gate is admin-only
 * (require_admin: role=admin or service API key).
 */
export const canManageWorkspaces = (role: MaybeRole): boolean => {
  const normalized = normalizeRole(role)
  if (!normalized || normalized === 'guest') return true // auth disabled -> open
  return normalized === 'admin'
}

/** User & permission administration (server /admin/* requires admin). */
export const canManageUsers = (role: MaybeRole): boolean => normalizeRole(role) === 'admin'

/** Workspace-level admin grant: full write plus delete of that workspace's data. */
export const isWorkspaceAdmin = (
  role: MaybeRole,
  accessLevel?: string | null | undefined
): boolean => {
  if (normalizeRole(role) === 'admin') return true
  return accessLevel === 'admin'
}
