/**
 * Create-time workspace grants: picking workspaces in the create form must
 * POST the user first and then PUT one permission row per picked workspace —
 * the new user may only see the granted workspaces after login. Role admin
 * bypasses workspace checks entirely, so the selector hides (and no grants
 * are written) for it.
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

describe('AdminUserPanel create-time workspace grants', () => {
  test('POSTs the user first, then PUTs one permission per picked workspace', async () => {
    const user = setup()
    renderPanel()

    // Popover trigger appears once workspaces loaded (default excluded).
    const trigger = await screen.findByRole('button', { name: 'Select workspaces' })
    await user.type(screen.getByPlaceholderText('username'), 'neo')
    await user.type(screen.getByPlaceholderText('password'), 'pw123456')

    await user.click(trigger)
    const alpha = await screen.findByText('alpha')
    expect(screen.getByText('beta')).toBeTruthy()
    // The default workspace has no server name and must not be offered.
    expect(screen.getAllByRole('checkbox').length).toBe(2)

    await user.click(alpha)
    await user.click(screen.getByText('beta'))
    expect(screen.getByRole('button', { name: '2 workspaces selected' })).toBeTruthy()

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

    // Form resets after a fully successful create.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select workspaces' })).toBeTruthy()
    })
    expect((screen.getByPlaceholderText('username') as HTMLInputElement).value).toBe('')
    // Users table reloaded with the created user.
    expect(screen.getByText('neo')).toBeTruthy()
  })

  test('admin role hides the workspace selector and writes no grants', async () => {
    const user = setup()
    renderPanel()
    await screen.findByRole('button', { name: 'Select workspaces' })

    // Switch role viewer → admin via the Radix select (value shows on trigger).
    await user.click(screen.getByText('viewer'))
    await user.click(await screen.findByRole('option', { name: 'admin' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Select workspaces' })).toBeNull()
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

    await user.type(screen.getByPlaceholderText('username'), 'neo')
    await user.type(screen.getByPlaceholderText('password'), 'pw123456')
    await user.click(await screen.findByRole('button', { name: 'Select workspaces' }))
    await user.click(await screen.findByText('alpha'))
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
})
