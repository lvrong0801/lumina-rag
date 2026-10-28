/**
 * Workspace CRUD flows run through dialogs: the create dialog must validate
 * the name client-side before any POST, the edit dialog PATCHes description
 * and status, and delete issues no request until its confirm dialog is
 * accepted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'sonner'

import * as api from '@/api/lightrag'
import { renderWithProviders } from '@/test/render'
import WorkspacePanel from './WorkspacePanel'

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
let workspaces: any[] = []

beforeEach(() => {
  calls = []
  workspaces = [
    { name: '', is_default: true, owner: 'admin', description: 'main', status: 'active' },
    { name: 'alpha', is_default: false, owner: 'admin', description: 'team a', status: 'active' }
  ]
  api.__setAxiosAdapterForTests(async (config: any) => {
    const url = config.url as string
    const method = (config.method as string | undefined)?.toLowerCase() ?? 'get'
    if (method === 'get' && url === '/workspaces') return ok([...workspaces], config)
    if (method === 'post' && url === '/workspaces') {
      const body = parseBody(config.data)
      calls.push({ method, url, data: body })
      workspaces.push({ name: body.name, is_default: false, description: body.description, status: 'active' })
      return ok({ status: 'success', message: 'created' }, config)
    }
    if (method === 'patch' && url.startsWith('/workspaces/')) {
      const body = parseBody(config.data)
      calls.push({ method, url, data: body })
      const name = decodeURIComponent(url.slice('/workspaces/'.length))
      const ws = workspaces.find((w) => w.name === name)
      if (ws) Object.assign(ws, body)
      return ok({ status: 'success', message: 'updated' }, config)
    }
    if (method === 'delete' && url.startsWith('/workspaces/')) {
      calls.push({ method, url, data: undefined })
      const name = decodeURIComponent(url.slice('/workspaces/'.length))
      workspaces = workspaces.filter((w) => w.name !== name)
      return ok({ status: 'success', message: 'deleted' }, config)
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
      <WorkspacePanel />
      <Toaster />
    </>
  )

const setup = () => userEvent.setup({ pointerEventsCheck: 0 })

describe('WorkspacePanel dialogs', () => {
  test('create dialog POSTs name + description and resets afterwards', async () => {
    const user = setup()
    renderPanel()

    await screen.findByText('alpha')
    await user.click(screen.getByRole('button', { name: /^New workspace$/ }))

    const nameInput = await screen.findByPlaceholderText('workspace-name')
    await user.type(nameInput, 'team-b')
    await user.type(screen.getByPlaceholderText('Description (optional)'), 'Team B space')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0]).toEqual({
      method: 'post',
      url: '/workspaces',
      data: { name: 'team-b', description: 'Team B space' }
    })
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('workspace-name')).toBeNull()
    })
    expect(screen.getByText('team-b')).toBeTruthy()
  })

  test('invalid name is rejected client-side with no POST', async () => {
    const user = setup()
    renderPanel()

    await screen.findByText('alpha')
    await user.click(screen.getByRole('button', { name: /^New workspace$/ }))
    await user.type(await screen.findByPlaceholderText('workspace-name'), 'bad name!')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(screen.getByText('Name may only contain letters, digits, underscores or hyphens.')).toBeTruthy()
    })
    expect(calls.length).toBe(0)
    // Dialog stays open for correction.
    expect(screen.getByPlaceholderText('workspace-name')).toBeTruthy()
  })

  test('edit dialog PATCHes description and status', async () => {
    const user = setup()
    renderPanel()

    const row = (await screen.findByText('alpha')).closest('tr')
    expect(row).not.toBeNull()
    await user.click(row!.querySelectorAll('button')[0]) // edit

    const descInput = (await screen.findByDisplayValue('team a'))
    await user.clear(descInput)
    await user.type(descInput, 'team a v2')

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Archived' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0]).toEqual({
      method: 'patch',
      url: '/workspaces/alpha',
      data: { description: 'team a v2', status: 'archived' }
    })
  })

  test('delete stays silent until the confirm dialog is accepted', async () => {
    const user = setup()
    renderPanel()

    const row = (await screen.findByText('alpha')).closest('tr')
    await user.click(row!.querySelectorAll('button')[1]) // delete
    await screen.findByText('Delete workspace')
    expect(calls.length).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(calls.length).toBe(1)
    })
    expect(calls[0].method).toBe('delete')
    expect(calls[0].url).toBe('/workspaces/alpha')
    await waitFor(() => {
      expect(screen.queryByText('alpha')).toBeNull()
    })
  })
})
