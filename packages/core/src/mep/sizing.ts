import {
  type DuctSectionProfile,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  flowAreaM2,
  roundDiameterForFlowM,
  roundDiameterM,
  velocityMps,
} from './aerodynamics'
import {
  NOISE_VELOCITY_THRESHOLD_MS,
  RECT_MAX_ASPECT_RATIO,
  RECT_MAX_DUCT_SIDE_MM,
  RECT_MIN_DUCT_SIDE_MM,
  RECT_SIDE_ROW_MM,
  ROUND_DUCT_SIZES_MM,
  recommendedVelocityRange,
  type VelocityRange,
} from './constants'
import type { AnnualHoursBand, BuildingClass, ResidentialSection, SystemType } from './norms-types'

/**
 * Auto-sizing of a duct section per СП 60 прил. Л: pick the velocity band
 * for the section's system/flow/hours, derive the smallest cross-section
 * that keeps the velocity inside it, then snap the size onto the ГОСТ
 * Р 70349 row. Pure logic — the stage-4 bypass and the stage-6
 * specification both reuse the same pickers.
 */

export type SizingOptions = {
  /** Design flow, m³/h. */
  flowM3h: number
  system: SystemType
  hoursBand?: AnnualHoursBand
  buildingClass?: BuildingClass
  residentialSection?: ResidentialSection
  /** Round by default; rect picks the standard W×H combination. */
  shape?: 'round' | 'rect'
  /** Hard velocity cap (m/s) overriding the norm band — e.g. a user's
   *  acoustic constraint. */
  maxVelocityMps?: number
}

export type SizingResult = {
  profile: DuctSectionProfile
  /** Actual cross-section area, m². */
  areaM2: number
  /** Resulting velocity, m/s. */
  velocityMps: number
  flowM3h: number
  /** The norm band the section was sized against. */
  recommendedVelocity: VelocityRange
  /** True when the resulting velocity exceeds the noise threshold. */
  noiseCheckRequired: boolean
}

/** Smallest ГОСТ round size ≥ the required diameter (falls back to the
 *  largest catalogue size when nothing is big enough). */
export function nearestRoundDuctSizeMm(requiredDiameterM: number): number {
  const requiredMm = requiredDiameterM * 1000
  for (const size of ROUND_DUCT_SIZES_MM) {
    if (size >= requiredMm) return size
  }
  return ROUND_DUCT_SIZES_MM[ROUND_DUCT_SIZES_MM.length - 1]!
}

export type RectDuctCandidate = {
  widthMm: number
  heightMm: number
  areaM2: number
  aspectRatio: number
}

/** Every standard W×H rect combination covering the required area (width ≥
 *  height, aspect ≤ `RECT_MAX_ASPECT_RATIO`), sorted by area then perimeter —
 *  the most compact, squarer sections first. */
export function rectDuctCandidates(requiredAreaM2: number): RectDuctCandidate[] {
  const requiredMm2 = requiredAreaM2 * 1e6
  const candidates: RectDuctCandidate[] = []
  for (const heightMm of RECT_SIDE_ROW_MM) {
    for (const widthMm of RECT_SIDE_ROW_MM) {
      if (widthMm < heightMm) continue
      const aspect = widthMm / heightMm
      if (aspect > RECT_MAX_ASPECT_RATIO) continue
      const areaMm2 = widthMm * heightMm
      if (areaMm2 < requiredMm2) continue
      if (widthMm > RECT_MAX_DUCT_SIDE_MM || heightMm < RECT_MIN_DUCT_SIDE_MM) continue
      candidates.push({
        widthMm,
        heightMm,
        areaM2: areaMm2 / 1e6,
        aspectRatio: aspect,
      })
    }
  }
  candidates.sort((a, b) => {
    if (a.areaM2 !== b.areaM2) return a.areaM2 - b.areaM2
    const aPerimeter = a.widthMm + a.heightMm
    const bPerimeter = b.widthMm + b.heightMm
    return aPerimeter - bPerimeter
  })
  return candidates
}

/** Best rect section for the required area, or null when no standard
 *  combination covers it (required area above the biggest allowed 2000×2000
 *  combination is impossible to place in a single rect run). */
export function bestRectDuctCandidate(requiredAreaM2: number): RectDuctCandidate | null {
  return rectDuctCandidates(requiredAreaM2)[0] ?? null
}

function roundProfileFor(requiredAreaM2: number): DuctSectionProfile {
  return {
    shape: 'round',
    diameterMm: nearestRoundDuctSizeMm(roundDiameterM(requiredAreaM2)),
  }
}

function rectProfileFor(requiredAreaM2: number): DuctSectionProfile | null {
  const candidate = bestRectDuctCandidate(requiredAreaM2)
  if (!candidate) return null
  return { shape: 'rect', widthMm: candidate.widthMm, heightMm: candidate.heightMm }
}

/** Size a single duct section. Returns null for a non-positive flow or a
 *  requested section the ГОСТ row cannot satisfy. */
export function sizeDuctSection(options: SizingOptions): SizingResult | null {
  if (!Number.isFinite(options.flowM3h) || options.flowM3h <= 0) return null

  const band = recommendedVelocityRange(
    options.system,
    options.flowM3h,
    options.hoursBand,
    options.buildingClass,
    options.residentialSection,
  )
  // Smallest duct in the norm band = velocity at the band's upper end; an
  // explicit cap (acoustic constraint) overrides it.
  const targetVelocity = Math.min(band.max, options.maxVelocityMps ?? Number.POSITIVE_INFINITY)
  if (targetVelocity <= 0) return null

  const requiredAreaM2 = flowAreaM2(options.flowM3h, targetVelocity)
  const shape = options.shape ?? 'round'
  const profile =
    shape === 'round' ? roundProfileFor(requiredAreaM2) : rectProfileFor(requiredAreaM2)
  if (!profile) return null

  const areaM2 = ductSectionAreaM2(profile)
  const actualVelocity = velocityMps(options.flowM3h, areaM2)
  return {
    profile,
    areaM2,
    velocityMps: actualVelocity,
    flowM3h: options.flowM3h,
    recommendedVelocity: band,
    noiseCheckRequired: actualVelocity > NOISE_VELOCITY_THRESHOLD_MS,
  }
}

/** Convenience — the hydraulic diameter of a sized section (friction math). */
export function sectionHydraulicDiameterM(profile: DuctSectionProfile): number {
  return ductSectionHydraulicDiameterM(profile)
}

/** Convenience — round diameter needed for a flow at a target velocity,
 *  already snapped onto the ГОСТ round row. */
export function nearestRoundForFlowMm(flowM3h: number, velocityMps: number): number {
  return nearestRoundDuctSizeMm(roundDiameterForFlowM(flowM3h, velocityMps))
}
