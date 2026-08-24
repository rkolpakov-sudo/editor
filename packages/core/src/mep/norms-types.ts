import {
  SPACE_CATEGORIES,
  SPACE_CATEGORY_LABELS,
  SPACE_CATEGORY_RATES,
  type SpaceCategory,
} from '../schema/nodes/zone'

export type { SpaceCategory }
export { SPACE_CATEGORIES, SPACE_CATEGORY_LABELS, SPACE_CATEGORY_RATES }

/**
 * Air-loop system — the ГОСТ 21.602 designation of a duct run:
 *   supply  → П (приток)
 *   exhaust → В (вытяжка)
 *   return  → рециркуляция (возврат воздуха в установку)
 *
 * The duct-segment / duct-fitting schemas persist all three (stage-4
 * schema change). The engine routes П/В bypasses and marks systems per ГОСТ.
 */
export type SystemType = 'supply' | 'exhaust' | 'return'

/** Duct cross-section shape — matches the duct-segment schema enum. */
export type DuctShape = 'round' | 'rect' | 'oval'

/** Sheet-steel class for the material column of the specification
 *  (оцинкованная / нержавеющая / чёрная сталь). */
export type SheetType = 'galvanized' | 'stainless' | 'black'

/** Columns of the СП 60 прил. Л velocity tables: the annual number of
 *  operating hours of the system. */
export type AnnualHoursBand = 'lt2000' | '2000to4000' | '4000to6000' | 'gt6000'

/** Building class picks the velocity table: Л.1/Л.2 (public buildings) or
 *  the residential working default (Л.3 — full text is paid, values not
 *  verified). */
export type BuildingClass = 'public' | 'residential'

/** Section role inside a residential run — Л.3 distinguishes main
 *  branches/trunks (≤ 5 m/s) from room branches (2–3 m/s). */
export type ResidentialSection = 'branch' | 'main'
