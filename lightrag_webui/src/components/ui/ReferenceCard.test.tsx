import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import ReferenceCard from './ReferenceCard'

test('renders title and confidence', () => {
  render(
    <ReferenceCard
      title="User Manual V1.pdf"
      page={5}
      confidence={0.92}
      snippet="Referencing relevant documentation section."
      filePath="docs/manual.pdf"
    />
  )
  expect(screen.getByText('User Manual V1.pdf')).toBeInTheDocument()
  expect(screen.getByText('P.5')).toBeInTheDocument()
  expect(screen.getByText('92%')).toBeInTheDocument()
  expect(screen.getByText('Referencing relevant documentation section.')).toBeInTheDocument()
})

test('renders file path as fallback title', () => {
  render(
    <ReferenceCard
      filePath="reports/Q3-Earnings.pdf"
      title=""
      confidence={0.85}
    />
  )
  expect(screen.getByText('Q3-Earnings.pdf')).toBeInTheDocument()
})

test('renders without snippet', () => {
  render(<ReferenceCard title="Test" page={1} />)
  expect(screen.getByText('Test')).toBeInTheDocument()
})

test('renders without page', () => {
  render(<ReferenceCard title="No page" />)
  expect(screen.getByText('No page')).toBeInTheDocument()
})
