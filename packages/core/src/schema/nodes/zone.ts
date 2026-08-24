import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

/**
 * Room categories used by the MEP air-exchange engine (SP 54 / universal
 * base — see `docs/mep/01-air-exchange-residential.md`). Each value maps to
 * a normative air-exchange rate in `packages/core/src/mep/constants.ts`.
 */
export const SPACE_CATEGORIES = [
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
] as const
export type SpaceCategory = (typeof SPACE_CATEGORIES)[number]

/** Russian UI labels for the categories — shared by the zone inspector and
 *  the floorplan context menu so both surfaces never drift apart. */
export const SPACE_CATEGORY_LABELS: Record<SpaceCategory, string> = {
  kitchen_gas: 'Кухня (газ)',
  kitchen_electric: 'Кухня (электр.)',
  bath: 'Ванная',
  toilet: 'Туалет',
  combined_wc: 'Совмещённый санузел',
  living: 'Жилая комната',
  office_short: 'Офис <2000 ч',
  office_permanent: 'Офис постоянный',
  public: 'Общественное (по заданию)',
  industrial: 'Промышленное (по заданию)',
}

/** Normative air-exchange rate per category (СП 54) — display hint only;
 *  the numeric engine values live in `mep/constants.ts`. */
export const SPACE_CATEGORY_RATES: Record<SpaceCategory, string> = {
  kitchen_gas: '90 м³/ч',
  kitchen_electric: '60 м³/ч',
  bath: '25 м³/ч',
  toilet: '25 м³/ч',
  combined_wc: '50 м³/ч',
  living: '3 м³/ч·м²',
  office_short: '20 м³/ч·чел',
  office_permanent: '60 м³/ч·чел',
  public: 'по заданию',
  industrial: 'по заданию',
}

export const ZoneNode = BaseNode.extend({
  id: objectId('zone'),
  type: nodeType('zone'),
  name: z.string(),
  // Polygon boundary - array of [x, z] coordinates defining the zone
  polygon: z.array(z.tuple([z.number(), z.number()])),
  // Procedural room zones retain the walls that prove their enclosure. The
  // stored polygon remains a fallback for missing or temporarily open walls.
  autoFromWalls: z.boolean().default(false),
  boundaryWallIds: z.array(objectId('wall')).default([]),
  // Generic zones remain available for sites and analysis. Architectural
  // room documentation is opt-in so legacy zone behavior is unchanged.
  spaceRole: z.enum(['generic', 'room']).default('generic'),
  // Room air-exchange category for the MEP engine (SP 54 / universal base).
  // Auto-detected rooms default to `public` until reclassified from the zone
  // inspector (Stage 5); geometry alone cannot infer kitchen/bath/office.
  spaceCategory: z.enum(SPACE_CATEGORIES).default('public'),
  roomNumber: z.string().trim().max(32).default(''),
  enclosureStatus: z.enum(['auto', 'enclosed', 'open']).default('auto'),
  floorFinish: z.string().trim().max(120).default(''),
  wallFinish: z.string().trim().max(120).default(''),
  ceilingFinish: z.string().trim().max(120).default(''),
  ceilingHeight: z.number().min(0.1).default(2.7),
  occupancy: z.string().trim().max(80).default(''),
  clearDimensionPolicy: z.enum(['none', 'inside-faces', 'finish-faces']).default('none'),
  // Visual styling
  color: z.string().default('#3b82f6'), // Default blue
  metadata: z.json().optional().default({}),
}).describe(
  dedent`
  Zone schema - a polygon zone attached to a level
  - object: "zone"
  - id: zone id
  - levelId: level this zone is attached to
  - name: zone name
  - polygon: array of [x, z] points defining the zone boundary
  - autoFromWalls: whether the boundary follows an enclosed wall loop
  - boundaryWallIds: wall ids that prove the procedural enclosure
  - spaceRole: generic site/analysis zone or architectural room
  - spaceCategory: room air-exchange category for the MEP engine (kitchen_gas / kitchen_electric / bath / toilet / combined_wc / living / office_short / office_permanent / public / industrial)
  - roomNumber/finishes/ceilingHeight/occupancy: construction-document room metadata
  - enclosureStatus: auto-detected, explicitly enclosed, or open
  - clearDimensionPolicy: optional room clear-dimension datum preference
  - color: hex color for visual styling
  - metadata: zone metadata (optional)
  `,
)

export type ZoneNode = z.infer<typeof ZoneNode>
