import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'bun:test'
import DocumentCard from './DocumentCard'

const createStub = () => {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]) => calls.push(args)
  return { fn, calls }
}

const mockDoc = {
  id: 'doc1',
  file_path: 'reports/annual.pdf',
  created_at: '2026-01-12T10:00:00Z',
  updated_at: '2026-01-13T12:00:00Z',
  status: 'processed' as const,
  summary: 'Annual earnings report for Q3.'
}

test('renders document card content', () => {
  render(<DocumentCard doc={mockDoc} selected={false} onSelect={() => {}} />)
  expect(screen.getByText(/doc-doc1/)).toBeInTheDocument()
  expect(screen.getByText('Annual earnings report for Q3.')).toBeInTheDocument()
})

test('renders with fileName when showFileName=true', () => {
  render(<DocumentCard doc={mockDoc} selected={false} onSelect={() => {}} showFileName />)
  expect(screen.getByText('annual.pdf')).toBeInTheDocument()
})

test('calls onSelect when checkbox toggled', async () => {
  const stub = createStub()
  render(
    <DocumentCard doc={mockDoc} selected={false} onSelect={stub.fn} />
  )
  const checkbox = screen.getByRole('checkbox')
  await userEvent.click(checkbox)
  expect(stub.calls.length).toBe(1)
  expect(stub.calls[0]).toEqual(['doc1', true])
})
