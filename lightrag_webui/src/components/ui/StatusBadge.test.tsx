import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import StatusBadge from './StatusBadge'

test('renders completed status with text', () => {
  render(<StatusBadge status="completed">Completed</StatusBadge>)
  expect(screen.getByText('Completed')).toBeInTheDocument()
})

test('renders parsing status with loader', () => {
  render(<StatusBadge status="parsing">Parsing...</StatusBadge>)
  expect(screen.getByText('Parsing...')).toBeInTheDocument()
})

test('renders failed status', () => {
  render(<StatusBadge status="failed">Failed</StatusBadge>)
  expect(screen.getByText('Failed')).toBeInTheDocument()
})

test('renders without icon when showIcon=false', () => {
  const { container } = render(
    <StatusBadge status="completed" showIcon={false}>No icon</StatusBadge>
  )
  const icon = container.querySelector('svg')
  expect(icon).toBeNull()
})
