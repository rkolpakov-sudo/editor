import { describe, expect, test } from 'bun:test'
import { frictionPressureDropPerMeterPa, velocityMps } from './aerodynamics'
import {
  bestRectDuctCandidate,
  EQUAL_FRICTION_DEFAULT_PA_PER_M,
  nearestRoundDuctSizeMm,
  nearestRoundForFlowMm,
  rectDuctCandidates,
  roundDiameterForFrictionM,
  sizeDuctSection,
} from './sizing'

describe('sizeDuctSection (round)', () => {
  test('1000 m³/h supply picks Ø315 on the ГОСТ row', () => {
    const result = sizeDuctSection({ flowM3h: 1000, system: 'supply', hoursBand: 'lt2000' })
    expect(result).not.toBeNull()
    expect(result!.profile).toEqual({ shape: 'round', diameterMm: 315 })
    // velocity settles below the band max because the ГОСТ step overshoots
    expect(result!.velocityMps).toBeCloseTo(3.5643, 3)
    expect(result!.noiseCheckRequired).toBe(false)
    expect(result!.recommendedVelocity).toEqual({ min: 4, max: 5 })
  })

  test('large flow snaps to the next catalogue size, never below norm', () => {
    const result = sizeDuctSection({ flowM3h: 20000, system: 'supply', hoursBand: 'lt2000' })
    expect(result!.profile).toEqual({ shape: 'round', diameterMm: 1250 })
  })

  test('residential branch uses the Л.3 working default', () => {
    const result = sizeDuctSection({
      flowM3h: 400,
      system: 'exhaust',
      buildingClass: 'residential',
      residentialSection: 'branch',
    })
    expect(result!.profile).toEqual({ shape: 'round', diameterMm: 250 })
    expect(result!.velocityMps).toBeCloseTo(2.2635, 3)
  })

  test('a hard velocity cap overrides the norm band', () => {
    const result = sizeDuctSection({ flowM3h: 1000, system: 'supply', maxVelocityMps: 4 })
    expect(result!.velocityMps).toBeLessThanOrEqual(4)
  })

  test('non-positive flow resolves to null', () => {
    expect(sizeDuctSection({ flowM3h: 0, system: 'supply' })).toBeNull()
    expect(sizeDuctSection({ flowM3h: -5, system: 'supply' })).toBeNull()
    expect(sizeDuctSection({ flowM3h: Number.NaN, system: 'supply' })).toBeNull()
  })
})

describe('sizeDuctSection (rect)', () => {
  test('picks the most compact standard W×H covering the area', () => {
    const result = sizeDuctSection({
      flowM3h: 1000,
      system: 'supply',
      hoursBand: 'lt2000',
      shape: 'rect',
    })
    expect(result).not.toBeNull()
    expect(result!.profile).toEqual({ shape: 'rect', widthMm: 300, heightMm: 200 })
  })
})

describe('ГОСТ row pickers', () => {
  test('nearestRoundDuctSizeMm returns the smallest size ≥ required', () => {
    expect(nearestRoundDuctSizeMm(0.266)).toBe(315)
    expect(nearestRoundDuctSizeMm(0.1)).toBe(100)
    expect(nearestRoundDuctSizeMm(0.19)).toBe(200)
    expect(nearestRoundDuctSizeMm(2.1)).toBe(2000) // beyond the row → max
  })

  test('nearestRoundForFlowMm sizes a flow at a target velocity', () => {
    expect(nearestRoundForFlowMm(1000, 5)).toBe(315)
  })

  test('roundDiameterForFrictionM hits the equal-friction target from both sides', () => {
    const diameterM = roundDiameterForFrictionM(1000, EQUAL_FRICTION_DEFAULT_PA_PER_M)!
    const areaM2 = (Math.PI * diameterM * diameterM) / 4
    const rate = frictionPressureDropPerMeterPa(diameterM, velocityMps(1000, areaM2))
    // Бисекция даёт наименьший D с R(D) ≤ цели.
    expect(rate).toBeLessThanOrEqual(EQUAL_FRICTION_DEFAULT_PA_PER_M + 1e-6)

    // Монотонность: большему расходу нужен больший диаметр при той же цели.
    const small = roundDiameterForFrictionM(300, EQUAL_FRICTION_DEFAULT_PA_PER_M)!
    const large = roundDiameterForFrictionM(3000, EQUAL_FRICTION_DEFAULT_PA_PER_M)!
    expect(large).toBeGreaterThan(small)

    // Деградированные входы.
    expect(roundDiameterForFrictionM(0, EQUAL_FRICTION_DEFAULT_PA_PER_M)).toBeNull()
    expect(roundDiameterForFrictionM(-5, 1)).toBeNull()
    expect(roundDiameterForFrictionM(1000, 0)).toBeNull()
  })

  test('rectDuctCandidates respects aspect ratio and orders by area', () => {
    const candidates = rectDuctCandidates(0.055556)
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate.widthMm / candidate.heightMm).toBeLessThanOrEqual(4)
      expect(candidate.areaM2).toBeGreaterThanOrEqual(0.055556 - 1e-9)
    }
    const best = bestRectDuctCandidate(0.055556)
    expect(best).toEqual({ widthMm: 300, heightMm: 200, areaM2: 0.06, aspectRatio: 1.5 })
  })
})
