import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import ErrorState from './ErrorState'

test('renders title and description', () => {
  render(
    <ErrorState
      title="Something went wrong"
      description="Failed to load documents"
    />
  )
  expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  expect(screen.getByText('Failed to load documents')).toBeInTheDocument()
})

test('shows retry button when onRetry is provided', () => {
  const onRetry = () => {}
  render(<ErrorState title="Error" onRetry={onRetry} retryLabel="Try again" />)
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
})

test('hides retry button when onRetry is absent', () => {
  render(<ErrorState title="Error" />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
