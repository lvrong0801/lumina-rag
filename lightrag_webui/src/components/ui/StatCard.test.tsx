import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import StatCard from './StatCard'
import { HardDriveIcon } from 'lucide-react'

test('renders title and value', () => {
  render(<StatCard title="Storage" value="2.5 GB" />)
  expect(screen.getByText('Storage')).toBeInTheDocument()
  expect(screen.getByText('2.5 GB')).toBeInTheDocument()
})

test('renders as loading skeleton when loading=true', () => {
  const { container } = render(<StatCard title="Storage" loading />)
  expect(container.querySelector('.animate-pulse')).not.toBeNull()
})

test('renders trend badge when trend is provided', () => {
  render(<StatCard title="Growth" value="42%" trend={5} trendLabel="vs last week" />)
  expect(screen.getByText('5%')).toBeInTheDocument()
})

test('renders icon when provided', () => {
  render(<StatCard title="Storage" value="2.5 GB" icon={HardDriveIcon} />)
  expect(screen.getByText('Storage')).toBeInTheDocument()
})
