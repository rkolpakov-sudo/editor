// Server-safe migration for the duct unit switch (inches → millimeters).
//
// Duct nodes were created with nominal US sizes in inches (round Ø4"–48",
// rect/oval sides 4"–60"). The schemas now store millimeters on the GOST
// R 70349 row. Everything here is pure data logic with no store, React, or
// Three.js imports so it can run in Server Components and API routes.

const INCHES_PER_MM = 25.4

export type DuctUnitsMigration = {
  changed: boolean
  nodes: Record<string, unknown>
}

// Legacy values are < 100 (max legacy duct dimension was 60" for rect
// sides, 48" round); new millimeter values are ≥ 100 (GOST row floor is
// Ø100 / 100mm sides). The boundary is clean because the pre-migration
// schema clamped every dimension to [2, 60] inches and the post-migration
// schema to [100, 2000] mm — no legal value straddles 100.
function isLegacyInches(node: Record<string, unknown>): boolean {
  if (node.metadata && typeof node.metadata === 'object' && 'migratedFromInches' in node.metadata) {
    return false
  }
  const dims = ['diameter', 'diameter2', 'width', 'height', 'width2', 'height2']
  return dims.some((key) => {
    const value = node[key]
    return typeof value === 'number' && Number.isFinite(value) && value < 100
  })
}

const DUCT_DIMENSION_KEYS = [
  'diameter',
  'diameter2',
  'width',
  'height',
  'width2',
  'height2',
] as const

// Exact ×25.4 keeps the rendered size identical to the legacy scene (the
// old geometry builder used 0.0254 m/in; the new one uses 0.001 m/mm).
// Rounded to 0.1 mm to shed float noise (6" → 152.4, 14" → 355.6).
function inchesToMm(value: number): number {
  return Math.round(value * INCHES_PER_MM * 10) / 10
}

/**
 * Migrates legacy duct nodes from nominal inches to millimeters.
 *
 * Idempotent: migrated nodes carry `metadata.migratedFromInches: true`, and
 * the marker short-circuits re-migration. The value-based check alone would
 * be unsafe — a migrated 2" round duct becomes 50.8mm, still < 100 — so the
 * marker is required.
 */
export function migrateDuctUnitsToMm(
  sourceNodes: Record<string, unknown>,
): DuctUnitsMigration {
  const nodes: Record<string, any> = { ...sourceNodes }
  let changed = false

  for (const [id, node] of Object.entries(nodes)) {
    if (node?.type !== 'duct-segment' && node?.type !== 'duct-fitting') continue
    if (!isLegacyInches(node)) continue

    const migrated: Record<string, unknown> = { ...node }
    for (const key of DUCT_DIMENSION_KEYS) {
      if (typeof node[key] === 'number' && Number.isFinite(node[key])) {
        migrated[key] = inchesToMm(node[key])
      }
    }
    migrated.metadata = { ...(node.metadata as Record<string, unknown>), migratedFromInches: true }
    nodes[id] = migrated
    changed = true
  }

  return changed ? { changed, nodes } : { changed, nodes: sourceNodes }
}