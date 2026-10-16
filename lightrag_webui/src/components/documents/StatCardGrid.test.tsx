import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import StatCardStrip from './StatCardGrid'

test('renders four stat cards', () => {
  render(
    <StatCardStrip
      total={42}
      parsed={30}
      size="1.2 GB"
      updatedAt="2026-01-15T10:00:00Z"
    />
  )
  expect(screen.getByText('Total Documents')).toBeInTheDocument()
  expect(screen.getByText('Parsed')).toBeInTheDocument()
  expect(screen.getByText('Storage Used')).toBeInTheDocument()
  expect(screen.getByText('Last Updated')).toBeInTheDocument()
})

test('renders formatted values', () => {
  render(
    <StatCardStrip
      total={42}
      parsed={30}
      size="1.2 GB"
      updatedAt="2026-01-15T10:00:00Z"
    />
  )
  expect(screen.getByText('42')).toBeInTheDocument()
  expect(screen.getByText('30 (71%)')).toBeInTheDocument()
  expect(screen.getByText('1.2 GB')).toBeInTheDocument()
})

test('renders loading skeleton when loading=true', () => {
  const { container } = render(
    <StatCardStrip total={0} parsed={0} size="—" loading />
  )
  const skeletons = container.querySelectorAll('.animate-pulse')
  expect(skeletons.length).toBeGreaterThan(0)
})
