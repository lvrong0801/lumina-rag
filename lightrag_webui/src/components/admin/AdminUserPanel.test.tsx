/**
 * Create-time workspace grants: picking workspaces in the create dialog must
 * POST the user first and then PUT one permission row per picked workspace —
 * the new user may only see the granted workspaces after login. Role admin
 * bypasses workspace checks entirely, so the grants section hides (and no
 * grants are written) for it. Delete requires a confirmation dialog before
 * any DELETE request goes out.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'sonner'

import * as api from '@/api/lightrag'
import { renderWithProviders } from '@/test/render'
import AdminUserPanel from './AdminUserPanel'

type Call = { method: string; url: string; data: any }

const ok = (data: any, config: any) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  config
})

const parseBody = (data: any) =>
  typeof data === 'string' ? JSON.parse(data) : data

let calls: Call[] = []
let users: any[] = []
let failGrantOn: string[] = []

beforeEach(() => {
  calls = []
  users = []
  failGrantOn = []
  api.__setAxiosAdapterForTests(async (config: any) => {
    const url = config.url as string
    const method = (config.method as string | undefined)?.toLowerCase() ?? 'get'
    if (method === 'get' && url === '/admin/users') return ok([...users], config)
    if (method === 'get' && url === '/workspaces') {
      return ok([
        { name: '', is_default: true },
        { name: 'alpha', is_default: false },
        { name: 'beta', is_default: false }
      ], config)
    }
    if (method === 'post' && url === '/admin/users') {
      const body = parseBody(config.data)
      calls.push({ method, url, data: body })
      users.push({ username: body.username, role: body.role, enabled: true })
      return ok({ status: 'success', message: 'created' }, config)
    }
    if (method === 'put' && url.startsWith('/admin/users/')) {
      const body = parseBody(config.data)
      calls.push({ method, url, data: body })
      if (failGrantOn.some((ws) => url.endsWith(`/permissions/${ws}`))) {
        throw Object.assign(new Error('grant boom'), { response: { status: 500, data: {} }, config })
      }
      return ok({ status: 'success', message: 'granted' }, config)
    }
    if ((method === 'patch' || method === 'delete') && url.startsWith('/admin/users/')) {
      const body = config.data ? parseBody(config.data) : undefined
      calls.push({ method, url, data: body })
      if (method === 'delete') {
        const name = decodeURIComponent(url.slice('/admin/users/'.length))
        users = users.filter((u) => u.username !== name)
      }
      return ok({ status: 'success', message: 'ok' }, config)
    }
    return ok({}, config)
  })
})

afterEach(() => {
  api.__setAxiosAdapterForTests(undefined)
  cleanup()
})

const renderPanel = () =>
  renderWithProviders(
    <>
      <AdminUserPanel />
      <Toaster />
    </>
  )

const setup = () => userEvent.setup({ pointerEventsCheck: 0 })

const openCreateDialog = async (user: ReturnType<typeof setup>) => {
  const trigger = await screen.findByRole('button', { name: /Create user/ })
  await user.click(trigger)
  return screen.findByPlaceholderText('username')
}

describe('AdminUserPanel dialogs', () => {
  test('create: POSTs the user first, then PUTs one permission per picked workspace', async () => {
    const user = setup()
    renderPanel()

    await openCreateDialog(user)
    await user.type(screen.getByPlaceholderText('username'), 'neo')
    await user.type(screen.getByPlaceholderText('password'), 'pw123456')

    // The default workspace has no server name and must not be offered.
    expect(screen.getAllByRole('checkbox').length).toBe(2)
    await user.click(screen.getByText('alpha'))
    await user.click(screen.getByText('beta'))

    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(calls.length).toBe(3)
    })
    expect(calls[0]).toEqual({
      method: 'post',
      url: '/admin/users',
      data: { username: 'neo', password: 'pw123456', role: 'viewer' }
    })
    expect(calls[1]).toEqual({
      method: 'put',
      url: '/admin/users/neo/permissions/alpha',
      data: { access_level: 'write' }
    })
    expect(calls[2]).toEqual({
      method: 'put',
      url: '/admin/users/neo/permissions/beta',
      data: { access_level: 'write' }
    })

    // Dialog closes and the reloaded table shows the created user.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('username')).toBeNull()
    })
    expect(screen.getByText('neo')).toBeTruthy()
  })

  test('admin role hides the grants section and writes no grants', async () => {
    const user = setup()
    renderPanel()

    await openCreateDialog(user)
    expect(screen.getAllByRole('checkbox').length).toBe(2)

    // Switch role viewer → admin via the role Radix select (first combobox).
    await user.click(screen.getAllByRole('combobox')[0])
    await user.click(await screen.findByRole('option', { name: /admin/ }))

    await waitFor(() => {
      expect(screen.queryAllByRole('checkbox').length).toBe(0)
    })

    await user.type(screen.getByPlaceholderText('username'), 'root2')
    await user.type(screen.getByPlaceholderText('password'), 'pw123456')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0].method).toBe('post')
    expect(calls[0].data.role).toBe('admin')
  })

  test('partial grant failure keeps the user and reports the failed workspaces', async () => {
    failGrantOn = ['beta']
    const user = setup()
    renderPanel()

    await openCreateDialog(user)
    await user.type(screen.getByPlaceholderText('username'), 'neo')
    await user.type(screen.getByPlaceholderText('password'), 'pw123456')
    await user.click(screen.getByText('alpha'))
    await user.click(screen.getByText('beta'))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(
        screen.getByText('User created, but granting these workspaces failed: beta')
      ).toBeTruthy()
    })
    // The user itself was still created and listed.
    expect(users.some((u) => u.username === 'neo')).toBe(true)
    expect(screen.getByText('neo')).toBeTruthy()
  })

  test('change password PATCHes the user and closes the dialog', async () => {
    users.push({ username: 'zed', role: 'viewer', enabled: true })
    const user = setup()
    renderPanel()

    // Icon-only actions: tooltip lives in a Radix portal, so no accessible
    // name — the row order is perm / edit / password / delete.
    const row = (await screen.findByText('zed')).closest('tr')
    expect(row).not.toBeNull()
    await user.click(row!.querySelectorAll('button')[2])
    const pwInput = await screen.findByPlaceholderText('New password')

    // Empty password is rejected client-side, no request goes out.
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.filter((c) => c.method === 'patch').length).toBe(0)

    await user.type(pwInput, 'new-secret-9')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0]).toEqual({
      method: 'patch',
      url: '/admin/users/zed',
      data: { password: 'new-secret-9' }
    })
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('New password')).toBeNull()
    })
  })

  test('edit dialog PATCHes only the changed fields', async () => {
    users.push({ username: 'zed', role: 'viewer', enabled: true })
    const user = setup()
    renderPanel()

    const row = (await screen.findByText('zed')).closest('tr')
    await user.click(row!.querySelectorAll('button')[1]) // edit

    await screen.findByText('Edit user "zed"')
    await user.click(screen.getAllByRole('combobox')[0])
    await user.click(await screen.findByRole('option', { name: /manager/ }))

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0]).toEqual({
      method: 'patch',
      url: '/admin/users/zed',
      data: { role: 'manager' }
    })
  })

  test('delete stays silent until the confirm dialog is accepted', async () => {
    users.push({ username: 'zed', role: 'viewer', enabled: true })
    const user = setup()
    renderPanel()

    const row = (await screen.findByText('zed')).closest('tr')
    await user.click(row!.querySelectorAll('button')[3]) // delete
    await screen.findByText('Delete user')
    expect(calls.length).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0]).toEqual({
      method: 'delete',
      url: '/admin/users/zed',
      data: undefined
    })
    await waitFor(() => {
      expect(screen.queryByText('zed')).toBeNull()
    })
  })

  test('user row survives cancel and save on the change-password dialog', async () => {
    users.push({ username: 'zed', role: 'viewer', enabled: true })
    const user = setup()
    renderPanel()

    // Cancel path: dialog closes, row must stay.
    const row = (await screen.findByText('zed')).closest('tr')
    await user.click(row!.querySelectorAll('button')[2]) // password
    await screen.findByPlaceholderText('New password')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('New password')).toBeNull()
    })
    expect(screen.getByText('zed')).toBeTruthy()

    // Save path: dialog closes, row must stay.
    const row2 = (await screen.findByText('zed')).closest('tr')
    await user.click(row2!.querySelectorAll('button')[2])
    const pwInput = await screen.findByPlaceholderText('New password')
    await user.type(pwInput, 'pw-again-1')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('New password')).toBeNull()
    })
    expect(screen.getByText('zed')).toBeTruthy()
  })

  test('search filters the user table', async () => {
    users.push(
      { username: 'alice', role: 'viewer', enabled: true },
      { username: 'bob', role: 'manager', enabled: true }
    )
    const user = setup()
    renderPanel()

    await screen.findByText('alice')
    expect(screen.getByText('bob')).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Search users…'), 'ali')
    expect(screen.getByText('alice')).toBeTruthy()
    expect(screen.queryByText('bob')).toBeNull()
  })
})
