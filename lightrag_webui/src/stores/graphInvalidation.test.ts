/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { useGraphStore } from './graph'

// Regression: deleting a document left its nodes on the graph page until the
// manual refresh button was clicked, because nothing reopened the fetch gates
// or changed the fetch signature. invalidateGraphData() is the store-level
// recipe the document views call after a server-side change.

type GraphStateShape = ReturnType<typeof useGraphStore.getState>

let originalState: GraphStateShape

beforeAll(() => {
  originalState = useGraphStore.getState()
})

afterAll(() => {
  // Module-level store shared by every later test file in this process:
  // restore all keys (the snapshot carries the actions too).
  useGraphStore.setState(originalState, true)
})

describe('invalidateGraphData', () => {
  test('drops cached graphs and selection, reopens the fetch gates, bumps the version', () => {
    const store = useGraphStore.getState()
    store.setRawGraph({} as never)
    store.setSigmaGraph({ order: 7, size: 9 } as never)
    store.setSelectedNode('n1')
    store.setGraphDataFetchAttempted(true)
    store.setLabelsFetchAttempted(true)
    store.setLastSuccessfulQueryLabel('entity')
    const versionBefore = useGraphStore.getState().graphDataVersion

    store.invalidateGraphData()

    const after = useGraphStore.getState()
    expect(after.rawGraph === null).toBe(true)
    expect(after.sigmaGraph === null).toBe(true)
    expect(after.searchEngine === null).toBe(true)
    expect(after.selectedNode === null).toBe(true)
    expect(after.graphNodeCount === 0).toBe(true)
    expect(after.graphEdgeCount === 0).toBe(true)
    expect(after.graphDataFetchAttempted === false).toBe(true)
    expect(after.labelsFetchAttempted === false).toBe(true)
    expect(after.lastSuccessfulQueryLabel === '').toBe(true)
    expect(after.graphDataVersion === versionBefore + 1).toBe(true)
  })
})
