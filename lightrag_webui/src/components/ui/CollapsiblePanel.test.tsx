import { render, screen } from '@testing-library/react'
import { expect, test } from 'bun:test'
import CollapsiblePanel from './CollapsiblePanel'

test('renders children when expanded', () => {
  render(
    <CollapsiblePanel>
      <p>Panel content</p>
    </CollapsiblePanel>
  )
  expect(screen.getByText('Panel content')).toBeInTheDocument()
})

test('initially collapsed hides children', () => {
  render(
    <CollapsiblePanel defaultCollapsed={true}>
      <p>Hidden content</p>
    </CollapsiblePanel>
  )
  expect(screen.queryByText('Hidden content')).not.toBeInTheDocument()
})

test('toggle button works to collapse', async () => {
  const { getByLabelText, queryByText } = render(
    <CollapsiblePanel>
      <p>Visible content</p>
    </CollapsiblePanel>
  )
  expect(queryByText('Visible content')).toBeInTheDocument()

  const toggle = getByLabelText('Collapse panel')
  await toggle.click()

  expect(queryByText('Visible content')).not.toBeInTheDocument()
})
