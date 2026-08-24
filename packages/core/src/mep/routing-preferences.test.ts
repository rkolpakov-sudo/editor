import { describe, expect, test } from 'bun:test'
import { BYPASS_MIN_GAP_MM, ELBOW_RADIUS_FACTOR } from './constants'
import { DEFAULT_ROUTING_PREFERENCES, normalizeRoutingPreferences } from './routing-preferences'

describe('routing-preferences — данные предпочтений (PLAN-AGENT §2.3)', () => {
  test('дефолты согласованы с константами норм и монтажа', () => {
    expect(DEFAULT_ROUTING_PREFERENCES.branchFitting).toBe('auto')
    expect(DEFAULT_ROUTING_PREFERENCES.saddleMaxDiameterRatio).toBe(0.5)
    expect(DEFAULT_ROUTING_PREFERENCES.branchTapAngleDeg).toBe(45)
    expect(DEFAULT_ROUTING_PREFERENCES.elbowRadiusFactor).toBe(ELBOW_RADIUS_FACTOR)
    expect(DEFAULT_ROUTING_PREFERENCES.bypassGapMm).toBe(BYPASS_MIN_GAP_MM)
    expect(DEFAULT_ROUTING_PREFERENCES.sizingMethod).toBe('velocity-sp60')
    expect(DEFAULT_ROUTING_PREFERENCES.equalFrictionPaPerM).toBe(1)
  })

  test('normalize зажимает числа в разумные диапазоны', () => {
    const normalized = normalizeRoutingPreferences({
      saddleMaxDiameterRatio: 5,
      elbowRadiusFactor: 0.5,
      equalFrictionPaPerM: 100,
      terminalConnectToleranceM: 0,
      bypassGapMm: 3,
    })
    expect(normalized.saddleMaxDiameterRatio).toBe(0.95)
    expect(normalized.elbowRadiusFactor).toBe(1)
    expect(normalized.equalFrictionPaPerM).toBe(10)
    expect(normalized.terminalConnectToleranceM).toBe(0.05)
    expect(normalized.bypassGapMm).toBe(20)
  })

  test('неизвестные перечисления заменяются дефолтами, валидные — сохраняются', () => {
    const garbage = normalizeRoutingPreferences({
      branchFitting: 'magic' as never,
      branchTapAngleDeg: 60 as never,
      sizingMethod: 'quantum' as never,
    })
    expect(garbage.branchFitting).toBe('auto')
    expect(garbage.branchTapAngleDeg).toBe(45)
    expect(garbage.sizingMethod).toBe('velocity-sp60')

    const valid = normalizeRoutingPreferences({
      branchFitting: 'saddle',
      branchTapAngleDeg: 90,
      sizingMethod: 'equal-friction',
      equalFrictionPaPerM: 0.8,
    })
    expect(valid.branchFitting).toBe('saddle')
    expect(valid.branchTapAngleDeg).toBe(90)
    expect(valid.sizingMethod).toBe('equal-friction')
    expect(valid.equalFrictionPaPerM).toBe(0.8)
  })
})
