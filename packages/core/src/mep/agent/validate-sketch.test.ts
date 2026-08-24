import { describe, expect, test } from 'bun:test'
import type { DuctSketchRun } from '../../schema'
import { hasBlockers, validateSketch } from './validate-sketch'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

describe('validateSketch — блокеры и предупреждения эскиза (W1, W13)', () => {
  test('пустой эскиз — блокер no-runs', () => {
    const issues = validateSketch([])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('blocker')
    expect(issues[0]!.code).toBe('no-runs')
    expect(hasBlockers(issues)).toBe(true)
  })

  test('полилиния из одной точки — блокер single-point-run', () => {
    const issues = validateSketch([run('supply', [[2, 2]])])
    expect(hasBlockers(issues)).toBe(true)
    const issue = issues.find((i) => i.code === 'single-point-run')!
    expect(issue.severity).toBe('blocker')
    expect(issue.runIndex).toBe(0)
    expect(issue.pointIndex).toBe(0)
  })

  test('нулевой участок между совпадающими точками — блокер', () => {
    const issues = validateSketch([
      run('supply', [
        [0, 0],
        [0, 0],
        [3, 0],
      ]),
    ])
    const issue = issues.find((i) => i.code === 'zero-length-segment')!
    expect(issue.severity).toBe('blocker')
    expect(issue.pointIndex).toBe(0)
    expect(hasBlockers(issues)).toBe(true)
  })

  test('самопересечение восьмёркой — блокер self-crossing', () => {
    const issues = validateSketch([
      run('supply', [
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
      ]),
    ])
    const issue = issues.find((i) => i.code === 'self-crossing')!
    expect(issue.severity).toBe('blocker')
    expect(issue.runIndex).toBe(0)
    expect(hasBlockers(issues)).toBe(true)
  })

  test('разворот назад по себе — блокер self-overlap', () => {
    const issues = validateSketch([
      run('supply', [
        [0, 0],
        [3, 0],
        [0, 0],
        [0, 3],
      ]),
    ])
    const issue = issues.find((i) => i.code === 'self-overlap')!
    expect(issue.severity).toBe('blocker')
    // Касания в общих вершинах и стыки соседних участков не должны давать
    // ложных self-crossing.
    expect(issues.find((i) => i.code === 'self-crossing')).toBeUndefined()
  })

  test('дубль полилинии одной системы — предупреждение runs-overlap без блокеров', () => {
    const issues = validateSketch([
      run('supply', [
        [0, 0],
        [3, 0],
      ]),
      run('supply', [
        [1, 0],
        [2, 0],
      ]),
    ])
    expect(hasBlockers(issues)).toBe(false)
    const overlap = issues.find((i) => i.code === 'runs-overlap')!
    expect(overlap.severity).toBe('warning')
    expect(overlap.message).toContain('№1')
    expect(overlap.message).toContain('№2')
  })

  test('П и В на одной оси — предупреждение с подсказкой про утку', () => {
    const issues = validateSketch([
      run('supply', [
        [0, 0],
        [4, 0],
      ]),
      run('exhaust', [
        [1, 0],
        [3, 0],
      ]),
    ])
    const overlap = issues.find((i) => i.code === 'runs-overlap')!
    expect(overlap.severity).toBe('warning')
    expect(overlap.message).toContain('утка')
  })

  test('перпендикулярное пересечение П и В — не наложение', () => {
    const issues = validateSketch([
      run('supply', [
        [0, 0],
        [6, 0],
      ]),
      run('exhaust', [
        [3, -3],
        [3, 3],
      ]),
    ])
    expect(issues.find((i) => i.code === 'runs-overlap')).toBeUndefined()
  })

  test('нет установки на уровне — блокер no-equipment (W13)', () => {
    const issues = validateSketch(
      [
        run('supply', [
          [0, 0],
          [3, 0],
        ]),
      ],
      { hasEquipment: false },
    )
    const issue = issues.find((i) => i.code === 'no-equipment')!
    expect(issue.severity).toBe('blocker')
    expect(hasBlockers(issues)).toBe(true)
  })

  test('приток без вытяжки — предупреждение no-exhaust-run, и наоборот', () => {
    const onlySupply = validateSketch(
      [
        run('supply', [
          [0, 0],
          [3, 0],
        ]),
      ],
      { hasEquipment: true },
    )
    expect(onlySupply.find((i) => i.code === 'no-exhaust-run')?.severity).toBe('warning')
    expect(hasBlockers(onlySupply)).toBe(false)

    const onlyExhaust = validateSketch(
      [
        run('exhaust', [
          [0, 0],
          [3, 0],
        ]),
      ],
      { hasEquipment: true },
    )
    expect(onlyExhaust.find((i) => i.code === 'no-supply-run')?.severity).toBe('warning')
    expect(hasBlockers(onlyExhaust)).toBe(false)
  })

  test('точка вне габаритов уровня — блокер out-of-bounds с индексом точки', () => {
    const issues = validateSketch(
      [
        run('supply', [
          [5, 5],
          [12, 5],
        ]),
      ],
      {
        hasEquipment: true,
        bounds: { minXM: 0, minZM: 0, maxXM: 10, maxZM: 10 },
      },
    )
    const issue = issues.find((i) => i.code === 'out-of-bounds')!
    expect(issue.severity).toBe('blocker')
    expect(issue.pointIndex).toBe(1)
  })

  test('корректный эскиз П+В — ни замечаний, ни блокеров', () => {
    const issues = validateSketch(
      [
        run('supply', [
          [0, 0],
          [3, 0],
          [3, 3],
        ]),
        run('exhaust', [
          [6, 0],
          [6, 3],
          [9, 3],
        ]),
      ],
      { hasEquipment: true },
    )
    expect(issues).toEqual([])
    expect(hasBlockers(issues)).toBe(false)
  })
})
