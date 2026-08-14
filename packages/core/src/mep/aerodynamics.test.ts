import { describe, expect, test } from 'bun:test'
import {
  darcyFrictionFactor,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  ductSectionPerimeterM,
  elbowZeta,
  fanPowerKw,
  flowAreaM2,
  frictionPressureDropPerMeterPa,
  localPressureDropPa,
  pressureDropPa,
  rectAreaM2,
  rectEquivalentDiameterByAreaM,
  rectEquivalentDiameterByResistanceM,
  reynoldsNumber,
  roundDiameterForFlowM,
  roundDiameterM,
  velocityMps,
} from './aerodynamics'

describe('flow ↔ cross-section conversions', () => {
  test('velocity: v = Q/(3600·F)', () => {
    // Ø315 round → 0.07793 m²
    expect(velocityMps(1000, 0.07793)).toBeCloseTo(3.5643, 3)
  })

  test('area: F = Q/(3600·v)', () => {
    expect(flowAreaM2(1000, 5)).toBeCloseTo(0.055556, 5)
  })

  test('round diameter: d = √(4·F/π)', () => {
    expect(roundDiameterM(0.055556)).toBeCloseTo(0.26596, 4)
    expect(roundDiameterForFlowM(1000, 5)).toBeCloseTo(0.26596, 4)
  })
})

describe('rect equivalent diameters', () => {
  test('area-equivalent d_экв = √(4ab/π)', () => {
    expect(rectEquivalentDiameterByAreaM(400, 200)).toBeCloseTo(0.31915, 4)
  })

  test('resistance-equivalent d_экв = 2ab/(a+b)', () => {
    expect(rectEquivalentDiameterByResistanceM(400, 200)).toBeCloseTo(0.26667, 4)
  })

  test('rect area in m²', () => {
    expect(rectAreaM2(400, 200)).toBeCloseTo(0.08, 5)
  })
})

describe('section geometry', () => {
  test('round section area and hydraulic diameter', () => {
    const profile = { shape: 'round', diameterMm: 315 } as const
    expect(ductSectionAreaM2(profile)).toBeCloseTo(0.07793, 4)
    expect(ductSectionPerimeterM(profile)).toBeCloseTo(0.9896, 3)
    // hydraulic diameter of a round section equals its diameter
    expect(ductSectionHydraulicDiameterM(profile)).toBeCloseTo(0.315, 4)
  })

  test('rect section area and hydraulic diameter', () => {
    const profile = { shape: 'rect', widthMm: 400, heightMm: 200 } as const
    expect(ductSectionAreaM2(profile)).toBeCloseTo(0.08, 5)
    // 2ab/(a+b) = 2·0.4·0.2/0.6
    expect(ductSectionHydraulicDiameterM(profile)).toBeCloseTo(0.26667, 4)
  })

  test('flat-oval area subtracts the side-segment caps', () => {
    const profile = { shape: 'oval', widthMm: 400, heightMm: 200 } as const
    expect(ductSectionAreaM2(profile)).toBeCloseTo(0.071416, 4)
    expect(ductSectionPerimeterM(profile)).toBeCloseTo(1.02832, 4)
  })
})

describe('local resistance ξ', () => {
  test('tabulated values for 90°/45° at R=1.5D', () => {
    expect(elbowZeta(90, 1.5)).toBeCloseTo(0.21, 4)
    expect(elbowZeta(45, 1.5)).toBeCloseTo(0.13, 4)
    expect(elbowZeta(90, 1)).toBeCloseTo(0.35, 4)
    expect(elbowZeta(90, 2)).toBeCloseTo(0.15, 4)
  })

  test('interpolates between radius factors and angles', () => {
    expect(elbowZeta(90, 1.25)).toBeCloseTo(0.28, 4)
    expect(elbowZeta(60, 1.5)).toBeCloseTo(0.1567, 3)
  })

  test('local drop Z = ξ·ρv²/2', () => {
    expect(localPressureDropPa(0.21, 3.565)).toBeCloseTo(1.601, 3)
  })
})

describe('friction and total pressure drop', () => {
  test('Reynolds number and Darcy factor stay in a sane band', () => {
    const re = reynoldsNumber(0.315, 3.565)
    expect(re).toBeCloseTo(74865, -1)
    const lambda = darcyFrictionFactor(0.315, 3.565)
    expect(lambda).toBeGreaterThan(0.008)
    expect(lambda).toBeLessThan(0.08)
    expect(lambda).toBeCloseTo(0.01913, 4)
  })

  test('friction per meter R = λ·(ρv²/2)/d', () => {
    expect(frictionPressureDropPerMeterPa(0.315, 3.565)).toBeCloseTo(0.4631, 3)
  })

  test('ΔP = R·l + Z composes', () => {
    const drop = pressureDropPa({
      lengthM: 10,
      hydraulicDiameterM: 0.315,
      velocityMps: 3.565,
      zeta: 0.21,
    })
    expect(drop).toBeCloseTo(6.232, 3)
  })

  test('fan power N = Q·ΔP/(3600·η)', () => {
    expect(fanPowerKw(1000, 6.232, 0.6)).toBeCloseTo(0.002885, 6)
  })
})
