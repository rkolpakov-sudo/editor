# Changelog

## Unreleased

### Features

- Duct units switched from nominal inches to millimeters on the GOST R 70349 row (MEP stage 1). `duct-segment` and `duct-fitting` store sizes in mm (round Ø100–2000, default 160; rect/oval sides 100–2000, default 400×200) with schemaVersion 2. Legacy scenes saved in inches are migrated on load by `migrateDuctUnitsToMm` (exact ×25.4, idempotent via `metadata.migratedFromInches`), and the draw tool snaps to the GOST diameter row.
- Auto room zones from closed wall loops (MEP stage 2). Every detected room materializes as an auto zone (`autoFromWalls`, `spaceRole: 'room'`, `spaceCategory`), stays in sync with live wall edits — polygon and boundary walls update on reshape, the zone is deleted when its enclosing contour opens — and always renders in every structure layer (rooms no longer wait for the zones toggle; generic site zones still do). Zones now carry `spaceCategory` (`kitchen_gas`/`kitchen_electric`/`bath`/`toilet`/`combined_wc`/`living`/`office_short`/`office_permanent`/`public`/`industrial`, default `public`), the SP 54 air-exchange category consumed by the MEP engine (stage 3+).
- Undo/Redo buttons in the viewer toolbar (top-left, alongside the collapse and view-mode controls). The buttons subscribe to the history store via `subscribeHistoryCommandState`, dispatch through `runUndo`/`runRedo` (respecting the collaborative history delegate), and disable when nothing can be undone/redone. Keyboard shortcuts were already wired: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo.
- MEP ventilation calculation engine (MEP stage 3). New pure-logic module `packages/core/src/mep/`: normative constants (`recommendedVelocityRange` from СП 60 прил. Л tables Л.1/Л.2 + residential working default, `AIR_EXCHANGE_RATES` from СП 54, ГОСТ Р 70349 size rows, `BYPASS_MIN_GAP_MM`, mounting spacing), aerodynamics (`v=Q/(3600F)`, equivalent diameters, elbow ξ table with interpolation, `ΔP = Σ(R·l + Z)` friction + local drop, fan power), per-section auto-sizing (`sizeDuctSection` snaps to the ГОСТ row keeping velocity in the norm band), routing rules (mounting supports, wall-sleeve and fire-damper penetration checks), and duct-network analysis (`buildDuctNetworks`/`validateDuctNetwork` — open run ends, unconnected terminals, orphaned networks, mixed П/В loops).
- MEP auto-bypass for crossing П/В runs (MEP stage 4). Duct schemas now persist `system: 'supply' | 'exhaust' | 'return'` (П/В/рециркуляция), and duct fittings gained an `offset` (утка) type with `offset` / `offsetRadiusFactor` fields. New pure-logic service `packages/core/src/mep/bypass.ts`: `detectBypassCrossings` finds plan crossings between supply and exhaust segments on the same level (joints and different-level runs are skipped), and `planBypass` builds the S-shaped detour — lateral offset = supply body + 2×50 mm gap, bends 45° (R = 1.5D) with an automatic 90° fallback when the straight run each side cannot fit (`autoSwitchedTo90`), centerline geometry shared with the fitting renderer via `computeBypassGeometry`. `buildBypassMutations` splits the exhaust segment into before/after parts and creates the offset fitting so the whole bypass lands in one undo step. Given a flow, the plan also reports Σξ (2 отвода), ΔP over the bypass, and a ГОСТ Р 70349 resize suggestion. The утка renders in 3D and on floor plans with П/В/return color coding.
- MEP ventilation UI (MEP stage 5). A «Вентиляция» panel (toggled from the viewer toolbar) lists the duct networks with П1/В1/Р1 marking per ГОСТ 21.602 (`planSystemMarkings`), per-system length/open-end summary, connectivity findings, and a «Автообвод пересечений» button that plans and applies every П/В crossing detour as a single undo step (with 45°→90° auto-switch hints). Duct segments carry П1/В1 marking labels on the floor plan (`computeFloorplanLevelData` + `kind:'text'`). The duct-segment inspector gained an MEP section — ГОСТ cross-section, run length, ГОСТ straight-length breakdown, mounting count, and a flow input that sizes the section per СП 60 (velocity, ΔP, recommended ГОСТ size) — plus a «Разбить по ГОСТ» action that replaces a straight run with standard-length sections (`planGostSegmentation`/`applyGostSegmentation`). The zone inspector now shows the room's required air exchange (category → м³/ч per СП 54/СП 60) with a category selector.
- MEP export: specification and DXF plan (MEP stage 6). New pure-logic `packages/core/src/mep/specification.ts` builds the bill-of-materials (ведомость материалов) from the scene: duct runs grouped by ГОСТ Р 70349 profile and system, per-system П1/В1/Р1 summaries, ГОСТ straight-length decomposition with a non-standard-length warning, fittings counted by type/angle/size, terminals, supports, wall sleeves (гильзы) and fire dampers (СП 7.13130) from wall crossings. `specificationToCsv` / `specificationToText` serialize it (Russian-Excel `;`-separated CSV). New `packages/core/src/mep/dxf.ts` exports the ventilation floor plan as ASCII DXF — segment legs on system layers (П supply / В exhaust / Р return), fittings as circles, terminals as squares, and П1/В1/Р1 marking labels per ГОСТ 21.602. The ventilation panel gained a «Спецификация» table with CSV/DXF download buttons. MCP gained `mep_specification` and `mep_dxf` tools, and `describe_node` now describes duct segments/fittings/terminals with system markings, sizes in mm and run lengths. (IFC export of the Pascal scene is out of scope — `apps/ifc-converter` is import-only; system fields ride on the duct node schema and the MCP export tools.)
- MEP stage 7 tests. New integration test `packages/core/src/mep/pipeline.test.ts` (7 tests) walks the full pipeline on one scene — «план → зоны → трассы П/В → пересечение → автообвод → расчёт → спецификация»: a closed wall loop materializes an auto zone (`detectSpacesForLevel`/`planAutoZonesForLevel`), the СП 54 category (kitchen 90 м³/ч) drives sizing, crossing supply/exhaust runs are detected and the утка (`planAllBypasses` + `buildBypassMutations`, offset = supply + 2×50 mm) resolves them in one step, `sizeDuctSection` picks the ГОСТ section by СП 60 прил. Л, and `buildDuctSpecification` counts ducts, the offset fitting, supports, sleeves and steel mass across П1/В1 systems.
- MEP stage 8 — whole-network calculation (вентиляционный расчёт всей сети П/В). New pure-logic modules in `packages/core/src/mep/`: `air-exchange.ts` (`polygonAreaM2`/`zoneCentroid`, `computeZoneAirflows` from СП 54 categories, `assignZoneAirflowsToTerminals` — each room's required flow goes to the nearest compatible supply/extract terminal, `terminalFlowMap`), `network-flows.ts` (shared port-graph primitive `buildDuctNetworkGraphs` — joints, adjacency, rooted spanning tree with the air handler as root — and `computeNetworkFlows` propagating terminal demands trunkward: segment flow = sum of terminals in its subtree), `network-pressure.ts` (paths equipment → each terminal with ΣΔP = friction R·l over segments + local ξ of fittings — elbows, утки, tees (`teeZeta`, pass vs branch by mated port), transitions (`transitionZeta`) — critical path = max ΔP, and branch balancing at junctions with the working ≤15% tolerance flagged `FITTING_ZETA_VERIFIED=false`), and `network-sizing.ts` (sizes every segment main → branch in BFS order per its own flow, `sizedProfiles` feeds the sized sections back into the pressure pass). The «Вентиляция» panel gained a «Расчёт сети» section — per-system ΣQ / critical-path ΔP summary, a segment table (marking, Q, ГОСТ section, v, ΔP) with in-band/noise highlighting, and balance warnings. Tests: `air-exchange` (9), `network-flows` (5), `network-pressure` (5), `network-sizing` (4) + a stage-8 integration step in `pipeline.test.ts` (kitchen 90 → flows on runs → Ø100 sizing → network ΔP). Total suite: 3207 pass / 1 skip / 0 fail.
- MEP stage 9 — утка v2: network-aware bypass. `bypass.ts` now extends the available straight run through collinear joints (`collinearRunAt`/`extendRunThroughJoints`), plans every crossing of one exhaust run as an ordered sequence of утки in a single command (`planBypassRun`/`planAllBypassRuns`/`buildBypassRunMutations` — one undo step, no `touchedExhaustIds` skip), checks vertical body clearance against `BYPASS_MIN_GAP_MM` instead of the hard 0.1 m band, auto-picks the S side on oblique crossings (`autoBypassSide` + longitudinal shift), and keeps a single elbow-ξ source in `aerodynamics.ts`. `bypass.test.ts` grew to 27 cases; `pipeline.test.ts` integrates «one exhaust × two supplies → 2 утки in the spec». Total suite: 3220 pass / 1 skip / 0 fail.
- MEP stage 10 — specification v2 and DXF v2. `specification.ts`: duct rows carry per-group `massKg` (perimeter × length × δ=0.8 mm × ρ=7850 kg/m³), link the stage-8 network sizing (`DuctSpecificationOptions.sizing`) into `flowM3h` / `velocityMps` / `sizedLabel` / `frictionDropPa` (surfaced as «Q, v, подбор, ΔP» in the note), and group fittings by type + size (`fittingSizeKey`, `size` column). `dxf.ts`: fittings are drawn by type instead of circles — elbow as an `ARC` (R=1.5D, 270° → 270°+angle), offset утка as the S-polyline from `computeBypassGeometry.keyPointsLocal`, tee/cross as lines (branch by `branchAngle`), reducer/transition as tapered pairs — with mm size labels («Отвод 90° Ø315», «Тройник Ø315/Ø160»); wall sleeves and fire dampers are marked at penetrations (`walls`/`fireRatedBarriers`, layers `MEP_SLEEVE`/`MEP_FIRE_DAMPER`), and a system legend («Системы», «П1 — Приток (MEP_SUPPLY)») sits below the plan. MCP `mep_dxf` passes walls and counts ARC entities; the ventilation panel feeds sizing into the spec and walls into the DXF. Tests: `specification.test.ts` 14, `dxf.test.ts` 12. Total suite: **3227 pass / 1 skip / 0 fail**.
- MEP stage 11 — norm verification. Mounting spacing verified against the full text of СП 73.13330.2016 § 6.5.5 (wayback copy of cntd `456029018`): runs < 400 mm → 4 m, ≥ 400 mm → 3 m for round/rect/oval alike (by diameter / larger side; flanged & nipple straight runs may reach 6 m — documented, not modelled). `MOUNTING_SPACING_VERIFIED = true` and `mountingSpacingM` fixed. Elbow ξ cited to the OViK designer's handbook (ed. I.G. Staroverov, part 3) + Idelchik in the `ELBOW_ZETA` docstring; residential Table Л.3 stays a documented working assumption (`TABLE_L3_VERIFIED=false`); the 50 mm П/В gap and ГОСТ 30494 occupied-zone velocities were confirmed. `bun check` / `check-types` / `bun test` green.
- MEP stage 12 — end-to-end regression. `mep/pipeline.test.ts` gained a full-pipeline v2 test (kitchen room → auto-zone → 90 m³/h → П/В runs crossing → утка with offset supply + 2×50 mm → network sizing Ø100/ΔP → specification v2 with П1/В1, утка, Q/sizing/ΔP → DXF v2 with markings, sleeves and legend) and an automated Playwright UI check drove the real editor: walls → auto-zone → «Кухня (газ)» in the zone inspector (90 m³/h, В) → П/В ducts → «Вентиляция» panel (networks П1/В1, «Расчёт сети» segment table С/Q/сечение/v/ΔP, ΣQ and critical path per network, «Спецификация» with mass 89.9 kg and 5 supports) → CSV/DXF downloads (layers MEP_SUPPLY/MEP_EXHAUST/MEP_SLEEVE, fittings, sleeves, legend). Finding: the duct tool auto-melts crossing same-level runs into one network with a cross (auto-fitting) — for the утка scenario runs must sit on different elevations or networks be split manually. Total suite: **3228 pass / 1 skip / 0 fail**.
- MEP agent auto-routing plan approved (`docs/mep/PLAN-AGENT.md`): sketch-to-network workflow (draft П/В polylines → «Трассировка» button → normative network), fixed agent pipeline §2.2, routing preferences (Revit-style), equipment recommendations, Revit-model elevations, mandatory П/В balance check, and the W1–W13 risk-mitigation map.
- MEP agent stage A1 — `DuctSketchNode`. New level-scoped schema (`packages/core/src/schema/nodes/duct-sketch.ts`, registered in the builtin plugin and the event bus): runs of `{ system: supply|exhaust|return, points: [{x, z, elev: 'auto' | {axisM}}] }` — one sketch node per level, Revit-model elevation vocabulary. Plan-only kind: dashed system-tinted floorplan rendering, no 3D geometry/renderer/tool, `bake: 'strip'`; excluded from the MEP specification, DXF and GLB exports (asserted in tests).
- MEP agent stage A2 — duct tool Sketch mode. **K** toggles build ↔ sketch (session-persistent); clicks accumulate a plan polyline (grid snap + 45° lock, no port/fitting mating), **Enter** / double-click lands it as a run of the level's sketch node in one undo step; **S** cycles П/В/Р in both modes. Existing sketch runs render dim under the in-flight line (`depthTest` off so intent reads through walls); a cursor badge shows the active system. Deep-review hardening: Esc on an empty draft falls through to select via the shared `tool:cancel` path, the path-draft preview store is not polluted in sketch mode, and an in-flight draft is cleared on level switch so points never land in another level's sketch. Total suite: **3256 pass / 1 skip / 0 fail**.

### Fixes

- **Duct placement routed overhead by default** (СП 60/СП 73). The duct draw tool laid every run on the floor (`ceilingMode` off by default → point Y = 0), violating the normative requirement that воздуховоды hang under the ceiling/slab with a 50–150 mm clearance (`DUCT_CLEARANCE_MM`). Ceiling routing is now ON by default: points land at `top − clearance − halfHeight` under the ceiling actually covering them (falling back to the level storey top, never the floor), free-placed duct fittings do the same, and `C` toggles floor placement for risers/special runs. Verified in the live editor: a freshly drawn duct sits at y=2.29 m (ceiling 2.5 − 0.1 − 0.1) vs. legacy y=0.
- **П/В crossings stay separate for the МЭП bypass** (fix #2). The duct tool auto-fitting minted a tee/cross for ANY crossing run, welding П and В on the same elevation into one mixed network so the auto-bypass (утка) reported «Пересечений не найдено». Auto-fittings now only join runs of the SAME air loop (П-П / В-В); a new **S** key cycles the drawn run's system П/В/Р (supply/exhaust/return) so an exhaust run is drawn as В before crossing П.
- **Elbow bend radius R/D** (fix #1). `duct-fitting` gained `radiusFactor` (ГОСТ Р 70349 / ГОСТ 17375: R=1D short, R=1.5D standard, default 1.5). It feeds the elbow-ξ lookup in `network-pressure`, the specification label («Отвод 90° Ø200 R=1D»), and the DXF arc — the inspector exposes «R/D» for elbows.
- **Terminals default mount by type** (fix #3). `duct-terminal` parametrics `derive` sets the normative mount when the type changes: ceiling diffuser → `ceiling`, return grille → `wall`, floor supply register → `floor` (ГОСТ 21.602 / СП 60 practice).
- **Vertical (riser) mounting step** (fix #5). Riser legs are now supported on the СП 73.13330.2016 п. 6.5.7 step (≤ 4,5 м, `VERTICAL_MOUNTING_SPACING_M`) instead of the horizontal п. 6.5.5 rule — `supportCountForRun`/`planRunMounting`/specification count them separately.
- **Седлка and зонт in the ГОСТ nomenclature** (fix #4). `duct-fitting` `fittingType` gained `saddle` (врезка в бок) and `hood` (выход в атмосферу); the specification counts «Седелка»/«Зонт» rows and the DXF draws a half-disc / cone symbol per `docs/mep/02`.


- Normalize repository line endings to LF via `.gitattributes` (`* text=auto eol=lf`), so `bun check` (Biome, which validates LF) passes on Windows checkouts instead of flagging every file as CRLF-reformatted. Also fixed the six latent formatting violations from MEP stage 1 that the CRLF wall had masked (missing trailing newline in `duct-units-migration.ts`, collapsed signatures in `duct-segment/tool.tsx`, import ordering in `use-scene.ts`/`scene-migrations.ts`/`duct-fitting/parametrics.ts`, indentation in `auto-fitting.test.ts`).
- CLI managed runtime now verifies recorded editor/MCP process identity on Windows (via `Get-CimInstance Win32_Process`) instead of always refusing force-stop. Previously `stopEditor({force: true})` threw `state_conflict` on win32, leaving detached editor and MCP subprocesses running — which hung `bun test` until they were killed.
- Preserve custom scene materials across save, load, clone, fork, and live sync. Materials were dropped at every persistence boundary, so a scene reopened with default surfaces. Collections were dropped on MCP import for the same reason ([#597](https://github.com/pascalorg/editor/pull/597)) by [@ShiroKSH](https://github.com/ShiroKSH)
- Wall junction mitering is now deterministic for exactly-collinear walls, so identical scenes produce identical geometry regardless of node iteration order ([#596](https://github.com/pascalorg/editor/pull/596)) by [@tomatotomata](https://github.com/tomatotomata)

## 1.0.0-beta.1 (2026-07-30)

The first Pascal Editor 1.0 beta. Relative to
[v0.9.1](https://github.com/pascalorg/editor/releases/tag/v0.9.1), this release
focuses the editor around a stable extensible scene model and production-grade
architectural workflows.

### Highlights

- **Terrain sculpting** — raise, lower, flatten, and smooth a compact height field with a persistent brush, live grid feedback, subtle continuous sound, undo-safe strokes, terrain raycasting, and first-person collision.
- **Terrain-aware construction** — walls, slabs, stairs, fences, columns, items, and other floor-placed nodes resolve stacked support and update live while terrain is sculpted. Wall and slab foundations can fill down to terrain without changing authored height or thickness.
- **Vertical modeling** — stored storey heights, raised-support drafting, explicit elevation anchors and guides, slab/deck stacking, auto-room surface elevation, wall/ceiling clamps, and support-aware placement above or below slabs.
- **Plugin and node architecture** — public node definitions, the built-in nodes package, plugin management, host integration primitives, and first-party Nature and MEP workflows.
- **Floor-plan and export workflows** — faster navigation, contextual dimensions and modes, more reliable placement and selection, textured GLB plus STL/OBJ export, capture framing, and hardened bake/walkthrough paths.
- **Rendering and interaction quality** — grounded lighting, safer WebGPU/WebGL fallbacks, deterministic snapping, group manipulation, improved camera/compass synchronization, and resilient legacy-scene migration.

### Packages

All public packages are published as `1.0.0-beta.1` under the npm `beta`
dist-tag. Stable `latest` installations remain on the 0.x line during the beta.

### Contributors

Thank you to [@wass08](https://github.com/wass08),
[@sudhir9297](https://github.com/sudhir9297),
[@anton-pascal](https://github.com/anton-pascal),
[@konevenkatesh](https://github.com/konevenkatesh),
[@MateoSaettone](https://github.com/MateoSaettone),
[@ruok-dev](https://github.com/ruok-dev),
[@mvanhorn](https://github.com/mvanhorn), and
[@kuishou68](https://github.com/kuishou68) for their work across the editor,
viewer, node library, MCP integration, documentation, and stability fixes.

**Full changelog**:
https://github.com/pascalorg/editor/compare/v0.9.1...v1.0.0-beta.1

## 0.6.0 (2026-04-21)

### Features

- **Multi-surface material system** — per-surface materials for walls, stairs, roofs with click-targeted 3D editing ([#266](https://github.com/pascalorg/editor/pull/266)) by [@sudhir9297](https://github.com/sudhir9297)
- **Automatic wall-room generation** — closed wall loops auto-split and generate slabs ([#255](https://github.com/pascalorg/editor/pull/255), [#257](https://github.com/pascalorg/editor/pull/257)) by [@sudhir9297](https://github.com/sudhir9297)
- **Stair-slab integration** — stair-driven cutouts in slabs and ceilings, auto ceilings from wall loops
- **Curved fence support** + endpoint move tools ([#267](https://github.com/pascalorg/editor/pull/267)) by [@sudhir9297](https://github.com/sudhir9297)
- **13 material presets** — granite, marble, parquet, wallpaper, wood and more ([#231](https://github.com/pascalorg/editor/pull/231)) by [@sudhir9297](https://github.com/sudhir9297)
- **Export scene system** — GLB, STL, OBJ formats ([#203](https://github.com/pascalorg/editor/pull/203)) by [@zephran-dev](https://github.com/zephran-dev), with STL/OBJ groundwork by [@mvanhorn](https://github.com/mvanhorn) ([#175](https://github.com/pascalorg/editor/pull/175))
- **Street view / walkthrough mode** ([#173](https://github.com/pascalorg/editor/pull/173)) by [@Yashism](https://github.com/Yashism)
- **Duplicate project** ([#178](https://github.com/pascalorg/editor/pull/178)) by [@kleenkanteen](https://github.com/kleenkanteen)
- **Editable wall length slider** ([#195](https://github.com/pascalorg/editor/pull/195)) by [@zephran-dev](https://github.com/zephran-dev)
- **Infinity dragging slider** using PointerLock API ([#206](https://github.com/pascalorg/editor/pull/206)) by [@claygeo](https://github.com/claygeo)
- **Material system enhancements** ([#201](https://github.com/pascalorg/editor/pull/201)) by [@PMAT77](https://github.com/PMAT77)
- **Editor layout redesign v2** + 3D box select
- **Move/rotate building** + relative positioning for all tools
- **Grid snap toolbar controls**
- **Cut-out button** in floating action menu for slabs and ceilings

### Fixes

- **WebGPU renderer** — await `renderer.init()` in Canvas GL factory ([#233](https://github.com/pascalorg/editor/pull/233)) by [@b9llach](https://github.com/b9llach)
- **WebGPU fallback** — skip post-processing when unavailable ([#234](https://github.com/pascalorg/editor/pull/234)) by [@b9llach](https://github.com/b9llach)
- **Crash on mode switch** — fix crash when switching to Furniture mode ([#237](https://github.com/pascalorg/editor/pull/237)) by [@txhno](https://github.com/txhno)
- **Crash on duplicate** — prevent crash when duplicating elements ([#239](https://github.com/pascalorg/editor/pull/239)) by [@nnhhoang](https://github.com/nnhhoang)
- **Delete walls/slabs** via floating action menu ([#180](https://github.com/pascalorg/editor/pull/180)) by [@nnhhoang](https://github.com/nnhhoang)
- **Counter-clockwise rotation** — T key for CCW rotation on selected nodes ([#184](https://github.com/pascalorg/editor/pull/184)) by [@nnhhoang](https://github.com/nnhhoang)
- **Scene singleton cleanup** — release singletons on Editor unmount ([#214](https://github.com/pascalorg/editor/pull/214)) by [@geopenta](https://github.com/geopenta)
- **State management & memory leaks** ([#152](https://github.com/pascalorg/editor/pull/152)) by [@hobostay](https://github.com/hobostay)
- **Ghost wall prevention** — use WALL_MIN_LENGTH constant ([#168](https://github.com/pascalorg/editor/pull/168)) by [@zephran-dev](https://github.com/zephran-dev)
- **Catalog image optimization** — add sizes and loading props ([#189](https://github.com/pascalorg/editor/pull/189)) by [@korvixhq](https://github.com/korvixhq)
- **Code cleanup** — remove unused `@ts-expect-error` directive ([#150](https://github.com/pascalorg/editor/pull/150)) by [@cs68614-hash](https://github.com/cs68614-hash)
- Robust undo/redo with nested history pause/resume
- Post-processing recovery after duplicate scene mutations
- Improved snapping across all geometry types
- Thumbnails, placement, and responsiveness improvements
- Stair elevation sync with floor slabs

### Contributors

A huge thank you to everyone who contributed to this release! 🎉

- [@sudhir9297](https://github.com/sudhir9297) — material system, wall-room generation, curved walls, stairs, fences (7 PRs!)
- [@zephran-dev](https://github.com/zephran-dev) — export system, wall length slider, ghost wall fix
- [@nnhhoang](https://github.com/nnhhoang) — rotation controls, delete actions, crash fix
- [@b9llach](https://github.com/b9llach) — WebGPU renderer fixes
- [@txhno](https://github.com/txhno) — furniture mode crash fix
- [@Yashism](https://github.com/Yashism) — street view / walkthrough mode
- [@claygeo](https://github.com/claygeo) — infinity dragging slider
- [@geopenta](https://github.com/geopenta) — scene singleton cleanup
- [@kleenkanteen](https://github.com/kleenkanteen) — duplicate project feature
- [@mvanhorn](https://github.com/mvanhorn) — STL/OBJ export formats
- [@PMAT77](https://github.com/PMAT77) — material system enhancements
- [@korvixhq](https://github.com/korvixhq) — catalog image optimization
- [@hobostay](https://github.com/hobostay) — state management & memory leak fixes
- [@cs68614-hash](https://github.com/cs68614-hash) — code cleanup
