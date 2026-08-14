import type {
  AnnualHoursBand,
  BuildingClass,
  ResidentialSection,
  SpaceCategory,
  SystemType,
} from './norms-types'

/**
 * Normative constants for the MEP ventilation engine (СП 60 прил. Л,
 * СП 54, ГОСТ Р 70349, СП 73/СП 7.13130). Pure data, no store or React —
 * the source tables live in `docs/mep/00..04`.
 *
 * Verification flags: values marked with a flag have not been verified
 * against the paid full text of the norm (see `docs/mep/05-sources-log.md`)
 * and are working defaults until the source is obtained.
 */

/** Л.3 (residential) values come from a working default — the paid full
 *  text is unobtainable; replace on access. */
export const TABLE_L3_VERIFIED = false
/** Mounting spacings are typical values pending the full СП 73 text. */
export const MOUNTING_SPACING_VERIFIED = false
/** Fitting local-resistance coefficients (tee/transition ξ) are working
 *  values from reference literature, pending a normative source. */
export const FITTING_ZETA_VERIFIED = false

/** Max imbalance between branch pressure drops at a junction before the
 *  network reports an unbalance (working threshold pending СП 60 review). */
export const BRANCH_BALANCE_TOLERANCE_PCT = 15

// ── Air physics ───────────────────────────────────────────────────────────
/** Air density at ~20 °C, kg/m³. */
export const AIR_DENSITY_KG_M3 = 1.2
/** Air kinematic viscosity at ~20 °C, m²/s (used for Reynolds numbers). */
export const AIR_KINEMATIC_VISCOSITY_M2_S = 1.5e-5

// ── Velocity tables (СП 60 прил. Л) ───────────────────────────────────────
export type VelocityRange = { min: number; max: number }

type VelocityRow = {
  /** Inclusive lower flow bound, m³/h. */
  flowMinM3h: number
  /** Exclusive upper flow bound, m³/h (Infinity for the top row). */
  flowMaxM3h: number
  bands: Record<AnnualHoursBand, VelocityRange>
}

/** Табл. Л.1 — recommended velocities in EXHAUST ducts, public buildings
 *  (m/s), by flow rate and annual operating hours. */
export const EXHAUST_VELOCITY_TABLE_L1: readonly VelocityRow[] = [
  {
    flowMinM3h: 0,
    flowMaxM3h: 500,
    bands: {
      lt2000: { min: 3.0, max: 4.0 },
      '2000to4000': { min: 2.5, max: 3.5 },
      '4000to6000': { min: 2.0, max: 3.0 },
      gt6000: { min: 1.5, max: 2.5 },
    },
  },
  {
    flowMinM3h: 500,
    flowMaxM3h: 2000,
    bands: {
      lt2000: { min: 4.0, max: 5.0 },
      '2000to4000': { min: 3.5, max: 4.5 },
      '4000to6000': { min: 3.0, max: 4.0 },
      gt6000: { min: 2.5, max: 3.5 },
    },
  },
  {
    flowMinM3h: 2000,
    flowMaxM3h: 5000,
    bands: {
      lt2000: { min: 4.5, max: 5.5 },
      '2000to4000': { min: 4.0, max: 5.0 },
      '4000to6000': { min: 3.5, max: 4.5 },
      gt6000: { min: 3.0, max: 4.0 },
    },
  },
  {
    flowMinM3h: 5000,
    flowMaxM3h: Number.POSITIVE_INFINITY,
    bands: {
      lt2000: { min: 5.0, max: 6.0 },
      '2000to4000': { min: 4.5, max: 5.5 },
      '4000to6000': { min: 4.0, max: 5.0 },
      gt6000: { min: 3.5, max: 4.5 },
    },
  },
]

/** Табл. Л.2 — recommended velocities in SUPPLY ducts (m/s). Return
 *  (рециркуляция) ducts are balanced with supply and are sized on the same
 *  table — a documented choice, since the norm does not name return runs. */
export const SUPPLY_VELOCITY_TABLE_L2: readonly VelocityRow[] = [
  {
    flowMinM3h: 0,
    flowMaxM3h: 3000,
    bands: {
      lt2000: { min: 4.0, max: 5.0 },
      '2000to4000': { min: 3.5, max: 4.5 },
      '4000to6000': { min: 3.0, max: 4.0 },
      gt6000: { min: 2.5, max: 3.5 },
    },
  },
  {
    flowMinM3h: 3000,
    flowMaxM3h: 10000,
    bands: {
      lt2000: { min: 5.0, max: 6.0 },
      '2000to4000': { min: 4.5, max: 5.5 },
      '4000to6000': { min: 4.0, max: 5.0 },
      gt6000: { min: 3.5, max: 4.5 },
    },
  },
  {
    flowMinM3h: 10000,
    flowMaxM3h: Number.POSITIVE_INFINITY,
    bands: {
      lt2000: { min: 5.5, max: 6.5 },
      '2000to4000': { min: 5.0, max: 6.0 },
      '4000to6000': { min: 4.5, max: 5.5 },
      gt6000: { min: 4.0, max: 5.0 },
    },
  },
]

/** Табл. Л.3 — residential working default (unverified): mains ≤ 5 m/s,
 *  room branches 2–3 m/s. */
export const RESIDENTIAL_VELOCITY_DEFAULTS: Record<ResidentialSection, VelocityRange> = {
  branch: { min: 2.0, max: 3.0 },
  main: { min: 0, max: 5.0 },
}

/** Recommend the velocity band for a section by system, flow, hours, and
 *  building class. Residential ignores the flow/hours lookups entirely. */
export function recommendedVelocityRange(
  system: SystemType,
  flowM3h: number,
  hoursBand: AnnualHoursBand = 'lt2000',
  buildingClass: BuildingClass = 'public',
  residentialSection: ResidentialSection = 'branch',
): VelocityRange {
  if (buildingClass === 'residential') {
    return RESIDENTIAL_VELOCITY_DEFAULTS[residentialSection]
  }
  const table = system === 'exhaust' ? EXHAUST_VELOCITY_TABLE_L1 : SUPPLY_VELOCITY_TABLE_L2
  for (const row of table) {
    if (flowM3h >= row.flowMinM3h && flowM3h < row.flowMaxM3h) {
      return row.bands[hoursBand]
    }
  }
  return table[table.length - 1]!.bands[hoursBand]
}

// ── Air exchange by space category (СП 54 + universal base) ───────────────
export type AirExchangeUnit = 'm3h' | 'm3h_per_m2' | 'm3h_per_person'

export type AirExchangeRule = {
  rate: number
  unit: AirExchangeUnit
  /** Which loop this space exhausts into or draws supply from. */
  flowDirection: SystemType
}

/** Room-type → normative air-exchange table (`docs/mep/01`). `public` and
 *  `industrial` have no fixed norm — flow comes from the design brief, so
 *  their rate is 0 (resolveRequiredAirflowM3h returns null for them). */
export const AIR_EXCHANGE_RATES: Record<SpaceCategory, AirExchangeRule> = {
  kitchen_gas: { rate: 90, unit: 'm3h', flowDirection: 'exhaust' },
  kitchen_electric: { rate: 60, unit: 'm3h', flowDirection: 'exhaust' },
  bath: { rate: 25, unit: 'm3h', flowDirection: 'exhaust' },
  toilet: { rate: 25, unit: 'm3h', flowDirection: 'exhaust' },
  combined_wc: { rate: 50, unit: 'm3h', flowDirection: 'exhaust' },
  living: { rate: 3, unit: 'm3h_per_m2', flowDirection: 'supply' },
  office_short: { rate: 20, unit: 'm3h_per_person', flowDirection: 'supply' },
  office_permanent: { rate: 60, unit: 'm3h_per_person', flowDirection: 'supply' },
  public: { rate: 0, unit: 'm3h', flowDirection: 'supply' },
  industrial: { rate: 0, unit: 'm3h', flowDirection: 'supply' },
}

export type RequiredAirflowInput = {
  /** Floor area in m² — required for `m3h_per_m2`. */
  areaM2?: number
  /** Occupant count — required for `m3h_per_person`. */
  occupants?: number
}

/** Resolve the normative airflow (m³/h) for a space category, or null when
 *  the category is by-design (public/industrial) or the input for a
 *  per-area / per-person rule is missing. */
export function resolveRequiredAirflowM3h(
  spaceCategory: SpaceCategory,
  input: RequiredAirflowInput = {},
): number | null {
  const rule = AIR_EXCHANGE_RATES[spaceCategory]
  if (rule.unit === 'm3h') return rule.rate > 0 ? rule.rate : null
  if (rule.unit === 'm3h_per_m2') {
    return input.areaM2 !== undefined ? rule.rate * input.areaM2 : null
  }
  return input.occupants !== undefined ? rule.rate * input.occupants : null
}

// ── ГОСТ Р 70349 size rows ────────────────────────────────────────────────
/** Round duct diameters, mm (ГОСТ Р 70349 + typical catalogues). */
export const ROUND_DUCT_SIZES_MM: readonly number[] = [
  100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
]
/** Rectangular duct side row, mm — combinations up to 2000×2000. */
export const RECT_SIDE_ROW_MM: readonly number[] = [
  100, 150, 200, 250, 300, 350, 400, 500, 600, 800, 1000, 1200, 1500, 2000,
]
/** Max allowed rect/oval side aspect ratio (typical practice limit). */
export const RECT_MAX_ASPECT_RATIO = 4
export const RECT_MIN_DUCT_SIDE_MM = 100
export const RECT_MAX_DUCT_SIDE_MM = 2000

/** Straight-section lengths, m — used by the stage-5 auto-segmentation. */
export const DUCT_SEGMENT_LENGTHS_M: readonly number[] = [0.5, 1.0, 1.25, 2.0, 2.5]

/** Standard elbow angles, degrees. */
export const ELBOW_ANGLES_DEG = [90, 45, 30, 15] as const
/** Standard bend radius factor — R = 1.5 × D. */
export const ELBOW_RADIUS_FACTOR = 1.5
/** Short-radius option — R = 1.0 × D. */
export const ELBOW_RADIUS_FACTOR_SHORT = 1.0

// ── Routing / installation ────────────────────────────────────────────────
/** Minimum gap between the bodies of crossing supply/exhaust ducts, mm
 *  (user decision, docs/mep/04). */
export const BYPASS_MIN_GAP_MM = 50
/** Duct run clearance off the ceiling/slab, mm (by design; typical range). */
export const DUCT_CLEARANCE_MM = { min: 50, max: 150 }
/** Sheet-metal wall thickness, mm (ГОСТ Р 70349, by size/class). */
export const SHEET_THICKNESS_MM = { min: 0.5, max: 1.0 }

/** Occupied-zone air velocity, m/s (ГОСТ 30494): optimum / allowed. */
export const OCCUPIED_ZONE_VELOCITY = {
  optimum: { min: 0.1, max: 0.15 },
  allowed: { min: 0, max: 0.25 },
} as const

/** Above this duct velocity (m/s) an acoustic check is required. */
export const NOISE_VELOCITY_THRESHOLD_MS = 5
