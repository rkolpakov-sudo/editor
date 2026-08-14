import { AIR_DENSITY_KG_M3, AIR_KINEMATIC_VISCOSITY_M2_S } from './constants'

/**
 * Aerodynamic sizing formulas for duct runs (СП 60 прил. Л + standard
 * network aerodynamics). Pure functions over geometry — no store, no
 * Three.js. Units: flow in m³/h, dimensions in millimeters, results in
 * SI (m, m/s, Pa) unless the name says otherwise.
 */

/** Cross-section profile of a duct run. Sizes are nominal millimeters on
 *  the GOST Р 70349 row. */
export type DuctSectionProfile =
  | { shape: 'round'; diameterMm: number }
  | { shape: 'rect' | 'oval'; widthMm: number; heightMm: number }

const M3_HOUR_TO_M3_S = 1 / 3600

function m2ToMm2(areaM2: number): number {
  return areaM2 * 1e6
}

function mmToM(valueMm: number): number {
  return valueMm / 1000
}

// ── Basic conversions ─────────────────────────────────────────────────────

/** Cross-section area required for a flow at a target velocity: F = Q/(3600·v), m². */
export function flowAreaM2(flowM3h: number, velocityMps: number): number {
  return (flowM3h * M3_HOUR_TO_M3_S) / velocityMps
}

/** Velocity for a flow through a cross-section: v = Q/(3600·F), m/s. */
export function velocityMps(flowM3h: number, areaM2: number): number {
  return (flowM3h * M3_HOUR_TO_M3_S) / areaM2
}

/** Round diameter for a cross-section area: d = √(4·F/π), meters. */
export function roundDiameterM(areaM2: number): number {
  return Math.sqrt((4 * areaM2) / Math.PI)
}

/** Round diameter for a flow at a target velocity, meters. */
export function roundDiameterForFlowM(flowM3h: number, velocityMps: number): number {
  return roundDiameterM(flowAreaM2(flowM3h, velocityMps))
}

/** Rectangular section area, m². */
export function rectAreaM2(widthMm: number, heightMm: number): number {
  return mmToM(widthMm) * mmToM(heightMm)
}

/** Rectangular equivalent diameter by area (flow): d_экв = √(4·a·b/π), meters. */
export function rectEquivalentDiameterByAreaM(widthMm: number, heightMm: number): number {
  return roundDiameterM(rectAreaM2(widthMm, heightMm))
}

/** Rectangular equivalent diameter by resistance: d_экв = 2·a·b/(a+b), meters. */
export function rectEquivalentDiameterByResistanceM(widthMm: number, heightMm: number): number {
  const a = mmToM(widthMm)
  const b = mmToM(heightMm)
  return (2 * a * b) / (a + b)
}

// ── Section geometry ──────────────────────────────────────────────────────

/** Flat-oval area: rectangle of width×(height−diameter) plus two semicircles
 *  of radius height/2 — i.e. W·H − (1 − π/4)·H². Valid for width ≥ height. */
function ovalAreaM2(widthMm: number, heightMm: number): number {
  const w = mmToM(widthMm)
  const h = mmToM(heightMm)
  return w * h - (1 - Math.PI / 4) * h * h
}

/** Cross-section area of a duct profile, m². */
export function ductSectionAreaM2(profile: DuctSectionProfile): number {
  if (profile.shape === 'round') {
    const d = mmToM(profile.diameterMm)
    return (Math.PI * d * d) / 4
  }
  if (profile.shape === 'oval') {
    return ovalAreaM2(profile.widthMm, profile.heightMm)
  }
  return rectAreaM2(profile.widthMm, profile.heightMm)
}

/** Wetted perimeter of a duct profile, m. */
export function ductSectionPerimeterM(profile: DuctSectionProfile): number {
  if (profile.shape === 'round') {
    return Math.PI * mmToM(profile.diameterMm)
  }
  if (profile.shape === 'oval') {
    const w = mmToM(profile.widthMm)
    const h = mmToM(profile.heightMm)
    return 2 * (w - h) + Math.PI * h
  }
  const w = mmToM(profile.widthMm)
  const h = mmToM(profile.heightMm)
  return 2 * (w + h)
}

/** Hydraulic diameter d_h = 4·A/P, meters — the resistance-equivalent
 *  diameter. Equals d for round and 2·a·b/(a+b) for rectangular sections. */
export function ductSectionHydraulicDiameterM(profile: DuctSectionProfile): number {
  return (4 * ductSectionAreaM2(profile)) / ductSectionPerimeterM(profile)
}

// ── Local resistance (ξ) ──────────────────────────────────────────────────

/**
 * Local resistance coefficients for elbows by turn angle and R/D factor.
 * Values for round ducts (R/D = 1.0 / 1.5 / 2.0) from «Справочник
 * проектировщика. Внутренние санитарно-технические устройства. Ч. 3.
 * Вентиляция и кондиционирование воздуха» (под ред. И.Г. Староверова) —
 * the primary ОВиК reference, tables for ξ of smooth round elbows
 * (колено круглого сечения); Идельчик И.Е. «Справочник по
 * гидравлическим сопротивлениям» gives the same order of magnitude.
 * Angles/radii between the tabulated points are linearly interpolated.
 */
const ELBOW_ZETA: Record<number, Record<number, number>> = {
  90: { 1: 0.35, 1.5: 0.21, 2: 0.15 },
  45: { 1: 0.25, 1.5: 0.13, 2: 0.1 },
  30: { 1: 0.2, 1.5: 0.08, 2: 0.06 },
  15: { 1: 0.1, 1.5: 0.05, 2: 0.04 },
}
const ELBOW_RADII = [1, 1.5, 2] as const
const ELBOW_ANGLES = [15, 30, 45, 90] as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function zetaAtRadius(row: Record<number, number>, radiusFactor: number): number {
  const r = clamp(radiusFactor, 1, 2)
  for (let i = 0; i < ELBOW_RADII.length - 1; i += 1) {
    const r0 = ELBOW_RADII[i]!
    const r1 = ELBOW_RADII[i + 1]!
    if (r >= r0 && r <= r1) {
      const t = (r - r0) / (r1 - r0)
      return row[r0]! + (row[r1]! - row[r0]!) * t
    }
  }
  return row[2]!
}

/** Local resistance coefficient ξ of a duct elbow. `angleDeg` is the turn
 *  (15–90), `radiusFactor` the R/D ratio (1–2). */
export function elbowZeta(angleDeg: number, radiusFactor: number): number {
  const angle = clamp(angleDeg, 15, 90)
  for (let i = 0; i < ELBOW_ANGLES.length - 1; i += 1) {
    const a0 = ELBOW_ANGLES[i]!
    const a1 = ELBOW_ANGLES[i + 1]!
    if (angle >= a0 && angle <= a1) {
      const t = (angle - a0) / (a1 - a0)
      const z0 = zetaAtRadius(ELBOW_ZETA[a0]!, radiusFactor)
      const z1 = zetaAtRadius(ELBOW_ZETA[a1]!, radiusFactor)
      return z0 + (z1 - z0) * t
    }
  }
  return zetaAtRadius(ELBOW_ZETA[90]!, radiusFactor)
}

/** Local pressure drop: Z = ξ · ρ·v²/2, Pa. */
export function localPressureDropPa(
  zeta: number,
  velocityMps: number,
  airDensityKgM3 = AIR_DENSITY_KG_M3,
): number {
  return zeta * ((airDensityKgM3 * velocityMps * velocityMps) / 2)
}

// ── Other fitting ξ (tee / transition) ────────────────────────────────────
// Working values from duct-network reference literature — no single
// normative table covers them, so they are flagged `FITTING_ZETA_VERIFIED =
// false` (see `docs/mep/05-sources-log.md`, stage 11 keeps them pending a
// source; elbows above are the verified part).

/** Local resistance coefficient ξ of a tee junction: the air either passes
 *  straight through the run (`viaBranch = false`, low ξ) or turns into the
 *  side tap (`viaBranch = true`, higher ξ). Working values pending a
 *  normative source — see `FITTING_ZETA_VERIFIED`. */
export function teeZeta(viaBranch: boolean): number {
  return viaBranch ? 0.6 : 0.1
}

/** Local resistance coefficient ξ of a reducer / square-to-round transition
 *  by the two section areas (m²). An abrupt change loses more as the area
 *  ratio diverges from 1 (straight-through); working value pending
 *  verification — see `FITTING_ZETA_VERIFIED`. */
export function transitionZeta(largerAreaM2: number, smallerAreaM2: number): number {
  if (largerAreaM2 <= 0) return 0
  const ratio = clamp(smallerAreaM2 / largerAreaM2, 0.1, 1)
  return 0.4 * (1 - ratio) * (1 - ratio)
}

// ── Friction (R·l) ────────────────────────────────────────────────────────

/** Reynolds number for a round/hydraulic diameter, m²/s viscosity. */
export function reynoldsNumber(
  diameterM: number,
  velocityMps: number,
  kinematicViscosityM2S = AIR_KINEMATIC_VISCOSITY_M2_S,
): number {
  return (velocityMps * diameterM) / kinematicViscosityM2S
}

/**
 * Darcy friction factor λ for smooth sheet-metal ducts:
 *   laminar (Re < 2300)  → 64/Re
 *   Blasius (≤ 1e5)      → 0.3164·Re⁻⁰·²⁵
 *   extended turbulent   → 0.184·Re⁻⁰·²
 * Clamped to a physically sane band.
 */
export function darcyFrictionFactor(
  diameterM: number,
  velocityMps: number,
  kinematicViscosityM2S = AIR_KINEMATIC_VISCOSITY_M2_S,
): number {
  const re = Math.max(1, reynoldsNumber(diameterM, velocityMps, kinematicViscosityM2S))
  let lambda: number
  if (re < 2300) {
    lambda = 64 / re
  } else if (re <= 1e5) {
    lambda = 0.3164 * re ** -0.25
  } else {
    lambda = 0.184 * re ** -0.2
  }
  return clamp(lambda, 0.008, 0.1)
}

/** Friction pressure drop per meter of run: R = λ · (ρ·v²/2) / d_h, Pa/m. */
export function frictionPressureDropPerMeterPa(
  hydraulicDiameterM: number,
  velocityMps: number,
  airDensityKgM3 = AIR_DENSITY_KG_M3,
): number {
  if (hydraulicDiameterM <= 0) return 0
  const lambda = darcyFrictionFactor(hydraulicDiameterM, velocityMps)
  const dynamicPressure = (airDensityKgM3 * velocityMps * velocityMps) / 2
  return (lambda * dynamicPressure) / hydraulicDiameterM
}

export type PressureDropInput = {
  lengthM: number
  /** Hydraulic diameter (use `ductSectionHydraulicDiameterM`). */
  hydraulicDiameterM: number
  velocityMps: number
  /** Sum of local resistance coefficients along the section (elbows, etc.). */
  zeta?: number
  airDensityKgM3?: number
}

/** Section pressure drop: ΔP = R·l + Z = Σ(R·l) + ξ·(ρ·v²/2), Pa. */
export function pressureDropPa(input: PressureDropInput): number {
  const friction = frictionPressureDropPerMeterPa(
    input.hydraulicDiameterM,
    input.velocityMps,
    input.airDensityKgM3,
  )
  const z = localPressureDropPa(input.zeta ?? 0, input.velocityMps, input.airDensityKgM3)
  return friction * input.lengthM + z
}

/** Fan shaft power for a section/system: N = Q·ΔP/(3600·η), kW. */
export function fanPowerKw(flowM3h: number, pressurePa: number, fanEfficiency = 0.6): number {
  if (fanEfficiency <= 0) return 0
  return (flowM3h * pressurePa) / (3600 * 1000 * fanEfficiency)
}

/** Nominal outer body dimension of a profile (m) — the width across a
 *  crossing's body used for clearance math: diameter for round, the larger
 *  side for rect/oval. */
export function profileBodyWidthM(profile: DuctSectionProfile): number {
  if (profile.shape === 'round') return mmToM(profile.diameterMm)
  return mmToM(Math.max(profile.widthMm, profile.heightMm))
}
