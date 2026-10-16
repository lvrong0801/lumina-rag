import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import EmptyState from './EmptyState'
import { FilesIcon } from 'lucide-react'

test('renders title and description', () => {
  render(
    <EmptyState
      title="No documents"
      description="Upload documents to get started"
    />
  )
  expect(screen.getByText('No documents')).toBeInTheDocument()
  expect(screen.getByText('Upload documents to get started')).toBeInTheDocument()
})

test('renders custom icon', () => {
  render(<EmptyState title="Custom icon" icon={FilesIcon} />)
  expect(screen.getByText('Custom icon')).toBeInTheDocument()
})

test('renders action slot', () => {
  render(
    <EmptyState
      title="With action"
      action={<button data-testid="action-btn">Launch</button>}
    />
  )
  expect(screen.getByTestId('action-btn')).toBeInTheDocument()
})

test('applies custom className', () => {
  const { container } = render(
    <EmptyState title="Styled" className="custom-class" />
  )
  expect(container.firstChild).toHaveClass('custom-class')
})

test('renders without description', () => {
  render(<EmptyState title="Title only" />)
  expect(screen.getByText('Title only')).toBeInTheDocument()
})
