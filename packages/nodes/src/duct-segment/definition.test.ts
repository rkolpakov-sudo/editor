import { describe, expect, test } from 'bun:test'
import { ductSegmentDefinition } from './definition'

describe('ductSegmentDefinition toolHints', () => {
  test('documents the sketch-mode toggle and finish gesture', () => {
    const hints = ductSegmentDefinition.toolHints ?? []
    expect(hints.find((h) => h.key === 'K')?.label).toContain('Sketch')
    expect(hints.find((h) => h.key === 'K')?.label).toContain('Enter')
    expect(hints.find((h) => h.key === 'S')?.label).toContain('П/В/Р')
    // Esc keeps its build-mode meaning; sketch Esc falls through to the
    // shared cancel path, so no separate hint row is claimed for it.
    expect(hints.filter((h) => h.key === 'Esc')).toHaveLength(1)
  })
})
