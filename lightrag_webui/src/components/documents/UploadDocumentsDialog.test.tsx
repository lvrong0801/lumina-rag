/**
 * Overwrite-mode uploads run a synchronous server-side purge + cached rebuild
 * of the target document before the new file is read, so the request can pin
 * for minutes (measured 92s against a cold embedding provider). The dialog
 * must therefore stay closable while the batch is in flight — the global
 * toast keeps reporting — and the toast wording must say "replacing", not a
 * quick "uploading", so a multi-minute wait does not look frozen.
 *
 * The fake backend sits at the axios adapter seam (see
 * ClearDocumentsDialog.test.tsx for why not mock.module): the real
 * `uploadDocument` runs, including its FormData assembly and interceptors.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'sonner'

import * as api from '@/api/lightrag'
import type { DocStatusResponse } from '@/api/lightrag'
import { renderWithProviders } from '@/test/render'
import UploadDocumentsDialog from './UploadDocumentsDialog'

const targetDoc: DocStatusResponse = {
  id: 'doc-target-1',
  file_path: 'seed.txt',
  status: 'processed',
  content_summary: '',
  content_length: 10,
  created_at: '2026-10-19T00:00:00Z',
  updated_at: '2026-10-19T00:00:00Z'
}

const ok = (data: any, config: any) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  config
})

// The test holds each upload request open until resolveUpload()/rejectUpload()
// is called, simulating the multi-minute overwrite request.
let resolveUpload: ((value: any) => void) | null = null
let rejectUpload: ((reason: any) => void) | null = null
const uploadFormBodies: FormData[] = []
const onDocumentsUploaded = mock(async () => {})

beforeEach(() => {
  api.__setPaginatedDocumentsPostForTests(async () => ({
    documents: [targetDoc],
    pagination: {
      page: 1,
      page_size: 200,
      total_count: 1,
      total_pages: 1,
      has_next: false,
      has_prev: false
    },
    status_counts: { processed: 1 }
  }))
  api.__setAxiosAdapterForTests(async (config: any) => {
    const url = config.url as string
    const method = (config.method as string | undefined)?.toLowerCase()
    if (method === 'post' && url === '/documents/upload') {
      uploadFormBodies.push(config.data as FormData)
      return new Promise((resolve, reject) => {
        resolveUpload = resolve
        rejectUpload = reject
      })
    }
    if (method === 'get' && url === '/documents/supported_file_types') {
      return ok({ supported_extensions: ['.txt'], engines: {} }, config)
    }
    if (method === 'get' && url === '/health') {
      return ok({ status: 'healthy', configuration: {} }, config)
    }
    // The dialog's version selector maps `.versions` as soon as it lands; the
    // `{}` fallthrough below would crash the tree the moment the dialog opens.
    if (method === 'get' && url === '/documents/versions') {
      return ok(
        { versions: [], latest_version: null, uncategorized_count: 0, total_count: 0 },
        config
      )
    }
    return ok({}, config)
  })
})

afterEach(() => {
  api.__setAxiosAdapterForTests(undefined)
  api.__resetPaginatedDocumentRequestsForTests()
  cleanup()
  onDocumentsUploaded.mockClear()
  uploadFormBodies.length = 0
  resolveUpload = null
  rejectUpload = null
})

const renderDialog = () =>
  renderWithProviders(
    <>
      <UploadDocumentsDialog onDocumentsUploaded={onDocumentsUploaded} />
      <Toaster />
    </>
  )

const openDialog = async () => {
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  // The uploader stays disabled until the supported-file-types probe lands.
  await waitFor(() => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input !== null && input.disabled).toBe(false)
  })
  return user
}

const dropFile = async (user: ReturnType<typeof userEvent.setup>, name = 'new.txt') => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, new File(['hello'], name, { type: 'text/plain' }))
  await waitFor(() => expect(uploadFormBodies.length).toBe(1))
}

const dialogCount = () => document.querySelectorAll('[role="dialog"]').length

describe('UploadDocumentsDialog', () => {
  test('stays closable while an upload request is in flight', async () => {
    const user = await openDialog()
    await dropFile(user)

    expect(dialogCount()).toBe(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(dialogCount()).toBe(0))

    // The request keeps running after the dialog closed; finishing it flips
    // the toast and refreshes the document list.
    resolveUpload?.(ok({ status: 'success', message: 'ok', track_id: 'trk-1' }, {}))
    await waitFor(() => expect(onDocumentsUploaded).toHaveBeenCalledTimes(1))
    await screen.findByText('Files uploaded successfully')
  })

  test('overwrite mode phrases the batch toast as replacing, per file', async () => {
    const user = await openDialog()
    await user.click(screen.getByRole('button', { name: 'Overwrite' }))
    await user.click(await screen.findByRole('checkbox'))

    await dropFile(user)
    await screen.findByText(/Replacing old document and uploading new\.txt \(1\/1\)/)

    // The replace wording also rides the initial long-lived toast, so close
    // the loop: resolve and confirm the success state still replaces it.
    resolveUpload?.(ok({ status: 'success', message: 'ok', track_id: 'trk-2' }, {}))
    await waitFor(() => expect(onDocumentsUploaded).toHaveBeenCalledTimes(1))

    // mode + target ids went to the server on the multipart form
    const form = uploadFormBodies[0]
    expect(form.get('mode')).toBe('overwrite')
    expect(form.getAll('target_doc_ids')).toEqual(['doc-target-1'])
  })

  test('maps a pipeline-busy 403 to a retry hint', async () => {
    const user = await openDialog()
    await user.click(screen.getByRole('button', { name: 'Overwrite' }))
    await user.click(await screen.findByRole('checkbox'))
    await dropFile(user)

    rejectUpload?.(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: {
          status: 403,
          data: {
            detail:
              'Deletion not allowed: current job "Indexing documents" is not a document deletion job'
          }
        }
      })
    )

    await screen.findByText(/pipeline is busy with another task/i)
    await screen.findByText('Some files failed to upload')
    expect(onDocumentsUploaded).toHaveBeenCalledTimes(0)
  })
})
