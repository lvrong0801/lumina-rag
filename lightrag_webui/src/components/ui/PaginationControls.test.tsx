/**
 * Regression test for "page-size selector disappears on a single page".
 *
 * The documents table hides the whole pagination bar when totalPages <= 1, and
 * PaginationControls used to `return null` in that case too. Picking a page size
 * >= totalCount therefore removed the only way to pick a smaller one again —
 * the bar stayed empty until the component remounted with fresh state. The bar
 * now stays mounted on single-page results: row-range text and the page-size
 * selector remain, only the page-number navigation is hidden.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, screen } from '@testing-library/react'

import PaginationControls from '@/components/ui/PaginationControls'
import { renderWithProviders } from '@/test/render'

const baseProps = {
  currentPage: 1,
  pageSize: 50,
  totalCount: 30,
  onPageChange: () => {},
  onPageSizeChange: () => {}
}

describe('PaginationControls', () => {
  afterEach(() => {
    cleanup()
  })

  test('keeps the page-size selector reachable when everything fits on one page', () => {
    renderWithProviders(<PaginationControls {...baseProps} totalPages={1} />)

    // The page-size Select trigger — this is the control a user needs to undo
    // an oversized page size; it must exist even with a single page of rows.
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    // Page-number navigation is meaningless on one page, so it stays hidden.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })

  test('shows page-number navigation when multiple pages exist', () => {
    renderWithProviders(<PaginationControls {...baseProps} totalPages={3} />)

    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.queryAllByRole('textbox').length > 0).toBe(true)
  })
})
