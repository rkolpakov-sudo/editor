import { describe, expect, test } from 'bun:test'
import {
  AIR_EXCHANGE_RATES,
  BYPASS_MIN_GAP_MM,
  DUCT_SEGMENT_LENGTHS_M,
  ELBOW_RADIUS_FACTOR,
  RECT_SIDE_ROW_MM,
  ROUND_DUCT_SIZES_MM,
  recommendedVelocityRange,
  resolveRequiredAirflowM3h,
} from './constants'

describe('recommendedVelocityRange', () => {
  test('exhaust follows table Л.1 by flow and hours', () => {
    expect(recommendedVelocityRange('exhaust', 400, 'lt2000')).toEqual({ min: 3, max: 4 })
    expect(recommendedVelocityRange('exhaust', 400, 'gt6000')).toEqual({ min: 1.5, max: 2.5 })
    expect(recommendedVelocityRange('exhaust', 600, 'lt2000')).toEqual({ min: 4, max: 5 })
    expect(recommendedVelocityRange('exhaust', 3000, 'lt2000')).toEqual({ min: 4.5, max: 5.5 })
    expect(recommendedVelocityRange('exhaust', 6000, 'lt2000')).toEqual({ min: 5, max: 6 })
  })

  test('supply follows table Л.2', () => {
    expect(recommendedVelocityRange('supply', 2500, 'lt2000')).toEqual({ min: 4, max: 5 })
    expect(recommendedVelocityRange('supply', 5000, 'lt2000')).toEqual({ min: 5, max: 6 })
    expect(recommendedVelocityRange('supply', 12000, 'lt2000')).toEqual({ min: 5.5, max: 6.5 })
  })

  test('return is sized on the supply table (balanced loops)', () => {
    expect(recommendedVelocityRange('return', 2500, 'lt2000')).toEqual(
      recommendedVelocityRange('supply', 2500, 'lt2000'),
    )
  })

  test('residential uses the Л.3 working default, ignoring flow', () => {
    expect(recommendedVelocityRange('supply', 50000, 'lt2000', 'residential', 'branch')).toEqual({
      min: 2,
      max: 3,
    })
    expect(recommendedVelocityRange('exhaust', 50, 'gt6000', 'residential', 'main')).toEqual({
      min: 0,
      max: 5,
    })
  })
})

describe('resolveRequiredAirflowM3h', () => {
  test('fixed-rate spaces return their norm (СП 54)', () => {
    expect(resolveRequiredAirflowM3h('kitchen_gas')).toBe(90)
    expect(resolveRequiredAirflowM3h('kitchen_electric')).toBe(60)
    expect(resolveRequiredAirflowM3h('bath')).toBe(25)
    expect(resolveRequiredAirflowM3h('toilet')).toBe(25)
    expect(resolveRequiredAirflowM3h('combined_wc')).toBe(50)
  })

  test('per-area spaces scale with area', () => {
    expect(resolveRequiredAirflowM3h('living', { areaM2: 20 })).toBe(60)
  })

  test('per-person spaces scale with occupants', () => {
    expect(resolveRequiredAirflowM3h('office_short', { occupants: 10 })).toBe(200)
    expect(resolveRequiredAirflowM3h('office_permanent', { occupants: 5 })).toBe(300)
  })

  test('by-design categories resolve to null', () => {
    expect(resolveRequiredAirflowM3h('public')).toBeNull()
    expect(resolveRequiredAirflowM3h('industrial')).toBeNull()
  })

  test('missing input for a scaled rule resolves to null', () => {
    expect(resolveRequiredAirflowM3h('living')).toBeNull()
    expect(resolveRequiredAirflowM3h('office_permanent', { areaM2: 20 })).toBeNull()
  })
})

describe('reference tables are present', () => {
  test('every space category has an air-exchange rule', () => {
    const categories = [
      'kitchen_gas',
      'kitchen_electric',
      'bath',
      'toilet',
      'combined_wc',
      'living',
      'office_short',
      'office_permanent',
      'public',
      'industrial',
    ]
    for (const category of categories) {
      expect(AIR_EXCHANGE_RATES[category as keyof typeof AIR_EXCHANGE_RATES]).toBeDefined()
    }
  })

  test('ГОСТ rows and installation constants match the reference', () => {
    expect(ROUND_DUCT_SIZES_MM).toEqual([
      100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
    ])
    expect(RECT_SIDE_ROW_MM).toContain(100)
    expect(RECT_SIDE_ROW_MM).toContain(2000)
    expect(DUCT_SEGMENT_LENGTHS_M).toEqual([0.5, 1.0, 1.25, 2.0, 2.5])
    expect(ELBOW_RADIUS_FACTOR).toBe(1.5)
    expect(BYPASS_MIN_GAP_MM).toBe(50)
  })
})
