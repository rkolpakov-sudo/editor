import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

/**
 * Duct fitting — the junction pieces that connect round duct segments:
 * elbows (direction change), tees (branch takeoff), reducers (diameter
 * transition).
 *
 * Phase 2 of the HVAC node system. Fittings are the first kind to expose
 * typed ports (`def.ports`) — placement tools snap duct endpoints onto a
 * fitting's collars, and the future system graph walks ports to decide
 * connectivity.
 *
 * `position` is level-local meters; `rotation` is an XYZ euler in radians
 * so a fitting can turn a horizontal run vertical (riser elbows).
 *
 * Local-frame conventions (before `rotation` is applied):
 *   - elbow:   inlet faces -X, outlet turned by `angle` degrees in the
 *              XZ plane (90° → +Z).
 *   - tee:     run along the X axis (ports face -X and +X), branch
 *              collar at `branchAngle`° from the +X (outlet) axis in the
 *              XZ plane — 90° a square straight tee, <90° a lateral
 *              leaning downstream toward the outlet, >90° leaning upstream
 *              toward the inlet — sized at `diameter2`.
 *   - cross:   four-way junction — run along the X axis (ports face -X
 *              and +X) at the run profile, two opposed branches square to
 *              the run along ±Z (branch faces +Z, branch2 faces -Z) at the
 *              branch profile (`shape2` / `diameter2`).
 *   - reducer: inlet at `diameter` faces -X, outlet at `diameter2`
 *              faces +X.
 *   - transition: square-to-round — rect end at `width` × `height` faces
 *              -X, round end at `diameter2` faces +X. `diameter` carries
 *              the rect end's area-equivalent round size.
 *   - offset: horizontal S / утка — the run shifts laterally by `offset`
 *              (mm) over two bends of `angle`° (R = `offsetRadiusFactor`×D)
 *              and returns to the original axis. Ports sit on the run axis
 *              at ±half-span, so the S reads as one in-line piece.
 */
export const DuctFittingNode = BaseNode.extend({
  id: objectId('duct-fitting'),
  type: nodeType('duct-fitting'),
  // Level-local meters.
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // XYZ euler radians.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  fittingType: z
    .enum(['elbow', 'tee', 'cross', 'reducer', 'transition', 'offset', 'saddle', 'hood'])
    .default('elbow'),
  // Run-leg cross-section: round collars, or a rect / flat-oval profile
  // matching the trunk the fitting sits in. Reducers ignore the shape.
  // When non-round, `diameter` carries the area-equivalent round size
  // (drives leg lengths + advertised ports).
  shape: z.enum(['round', 'rect', 'oval']).default('rect'),
  // Rect / oval run-leg profile in millimeters (used when shape ≠ 'round').
  // GOST R 70349 sides, 100–2000.
  width: z.number().min(100).max(2000).default(400),
  height: z.number().min(100).max(2000).default(200),
  // Tee / cross BRANCH cross-section: a round collar at `diameter2` or a
  // rect / oval profile matching the duct drawn off the tap. When
  // non-round, `diameter2` carries the branch's area-equivalent round
  // size. A cross's two opposed branches share this one profile.
  shape2: z.enum(['round', 'rect', 'oval']).default('rect'),
  // Rect / oval branch profile in millimeters (used when shape2 ≠ 'round').
  width2: z.number().min(100).max(2000).default(400),
  height2: z.number().min(100).max(2000).default(200),
  // Elbow turn angle in degrees. Residential sheet-metal elbows come in
  // 90° and 45°; adjustable elbows cover the range between. 0° is a
  // straight coupling — what an elbow flattens to when its run is dragged
  // into line with the fixed collar. For an `offset` (утка) it is the bend
  // angle of each of the S's four bends (45° default, 90° tight-space
  // fallback).
  angle: z.number().min(0).max(90).default(90),
  // Tee branch angle in degrees, measured off the +X (outlet) axis: 90°
  // is a square straight tee, <90° a lateral whose branch sweeps
  // downstream toward the outlet (flow merges), >90° leans the branch
  // upstream toward the inlet. Ignored by every other fitting type.
  branchAngle: z.number().min(45).max(135).default(90),
  // Main (run/inlet) nominal diameter in millimeters (GOST R 70349 row).
  diameter: z.number().min(100).max(2000).default(315),
  // Secondary diameter in millimeters — tee branch collar, reducer outlet.
  // Ignored by elbows.
  diameter2: z.number().min(100).max(2000).default(315),
  // Lateral axis displacement of an `offset` fitting, mm — how far the S
  // carries the run off its original axis and back. Defaults to the stage-4
  // bypass's minimum: supply body + 2 × 50 mm gap (BYPASS_MIN_GAP_MM).
  offset: z.number().min(50).max(2000).default(100),
  // Bend radius of an `offset` fitting as a multiple of the duct size
  // (R = offsetRadiusFactor × D). ГОСТ-типичный отвод 1.5D.
  offsetRadiusFactor: z.number().min(1).max(2).default(1.5),
  // Bend radius of an ELBOW as a multiple of the duct size: ГОСТ Р 70349 /
  // ГОСТ 17375 offer R=1D (short) and R=1.5D (standard) elbows. Drives the
  // ξ lookup (elbowZeta) and the specification's «R=…D» label. Ignored by
  // every other fitting type.
  radiusFactor: z.number().min(1).max(2).default(1.5),
  ductMaterial: z.enum(['sheet-metal', 'flex', 'duct-board']).default('sheet-metal'),
  system: z.enum(['supply', 'exhaust', 'return']).default('supply'),
  slots: z.record(z.string(), z.string()).optional(),
}).describe(
  dedent`
  Duct fitting - elbow, tee, cross, reducer, square-to-round transition, or offset (утка) between duct runs.
  - position: [x, y, z] level-local meters
  - rotation: [x, y, z] euler radians
  - fittingType: elbow | tee | cross | reducer | transition (rect end -X, round end +X) | offset (S, ports on the run axis) | saddle (врезка в бок) | hood (зонт на выход в атмосферу)
  - shape: round | rect | oval run legs (matches the trunk; ignored by reducer / transition)
  - width / height: rect / oval run-leg profile in mm (transition: the rect end)
  - shape2: round | rect | oval tee / cross branch (matches the duct drawn off the tap)
  - width2 / height2: rect / oval branch profile in mm
  - angle: elbow turn in degrees (45 or 90 typical); offset S bend angle (45 default, 90 tight-space fallback)
  - branchAngle: tee branch angle off the outlet axis (90 straight tee, 45 downstream lateral, 135 upstream); cross branches are always square
  - diameter: main nominal diameter in mm
  - diameter2: tee / cross branch / reducer outlet / transition round-end diameter in mm
  - offset: lateral axis displacement of the offset (утка), mm
  - offsetRadiusFactor: offset bend radius as R/D (default 1.5)
  - radiusFactor: elbow bend radius as R/D (1D short / 1.5D standard, default 1.5)
  - ductMaterial: sheet-metal | flex | duct-board
  - system: supply | exhaust | return
  `,
)
export type DuctFittingNode = z.infer<typeof DuctFittingNode>
export type DuctFittingNodeId = DuctFittingNode['id']
