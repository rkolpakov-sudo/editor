# Changelog

## Unreleased

### Features

- Duct units switched from nominal inches to millimeters on the GOST R 70349 row (MEP stage 1). `duct-segment` and `duct-fitting` store sizes in mm (round Ø100–2000, default 160; rect/oval sides 100–2000, default 400×200) with schemaVersion 2. Legacy scenes saved in inches are migrated on load by `migrateDuctUnitsToMm` (exact ×25.4, idempotent via `metadata.migratedFromInches`), and the draw tool snaps to the GOST diameter row.
- Auto room zones from closed wall loops (MEP stage 2). Every detected room materializes as an auto zone (`autoFromWalls`, `spaceRole: 'room'`, `spaceCategory`), stays in sync with live wall edits — polygon and boundary walls update on reshape, the zone is deleted when its enclosing contour opens — and always renders in every structure layer (rooms no longer wait for the zones toggle; generic site zones still do). Zones now carry `spaceCategory` (`kitchen_gas`/`kitchen_electric`/`bath`/`toilet`/`combined_wc`/`living`/`office_short`/`office_permanent`/`public`/`industrial`, default `public`), the SP 54 air-exchange category consumed by the MEP engine (stage 3+).
- Undo/Redo buttons in the viewer toolbar (top-left, alongside the collapse and view-mode controls). The buttons subscribe to the history store via `subscribeHistoryCommandState`, dispatch through `runUndo`/`runRedo` (respecting the collaborative history delegate), and disable when nothing can be undone/redone. Keyboard shortcuts were already wired: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo.
- MEP ventilation calculation engine (MEP stage 3). New pure-logic module `packages/core/src/mep/`: normative constants (`recommendedVelocityRange` from СП 60 прил. Л tables Л.1/Л.2 + residential working default, `AIR_EXCHANGE_RATES` from СП 54, ГОСТ Р 70349 size rows, `BYPASS_MIN_GAP_MM`, mounting spacing), aerodynamics (`v=Q/(3600F)`, equivalent diameters, elbow ξ table with interpolation, `ΔP = Σ(R·l + Z)` friction + local drop, fan power), per-section auto-sizing (`sizeDuctSection` snaps to the ГОСТ row keeping velocity in the norm band), routing rules (mounting supports, wall-sleeve and fire-damper penetration checks), and duct-network analysis (`buildDuctNetworks`/`validateDuctNetwork` — open run ends, unconnected terminals, orphaned networks, mixed П/В loops).
- MEP auto-bypass for crossing П/В runs (MEP stage 4). Duct schemas now persist `system: 'supply' | 'exhaust' | 'return'` (П/В/рециркуляция), and duct fittings gained an `offset` (утка) type with `offset` / `offsetRadiusFactor` fields. New pure-logic service `packages/core/src/mep/bypass.ts`: `detectBypassCrossings` finds plan crossings between supply and exhaust segments on the same level (joints and different-level runs are skipped), and `planBypass` builds the S-shaped detour — lateral offset = supply body + 2×50 mm gap, bends 45° (R = 1.5D) with an automatic 90° fallback when the straight run each side cannot fit (`autoSwitchedTo90`), centerline geometry shared with the fitting renderer via `computeBypassGeometry`. `buildBypassMutations` splits the exhaust segment into before/after parts and creates the offset fitting so the whole bypass lands in one undo step. Given a flow, the plan also reports Σξ (2 отвода), ΔP over the bypass, and a ГОСТ Р 70349 resize suggestion. The утка renders in 3D and on floor plans with П/В/return color coding.
- MEP ventilation UI (MEP stage 5). A «Вентиляция» panel (toggled from the viewer toolbar) lists the duct networks with П1/В1/Р1 marking per ГОСТ 21.602 (`planSystemMarkings`), per-system length/open-end summary, connectivity findings, and a «Автообвод пересечений» button that plans and applies every П/В crossing detour as a single undo step (with 45°→90° auto-switch hints). Duct segments carry П1/В1 marking labels on the floor plan (`computeFloorplanLevelData` + `kind:'text'`). The duct-segment inspector gained an MEP section — ГОСТ cross-section, run length, ГОСТ straight-length breakdown, mounting count, and a flow input that sizes the section per СП 60 (velocity, ΔP, recommended ГОСТ size) — plus a «Разбить по ГОСТ» action that replaces a straight run with standard-length sections (`planGostSegmentation`/`applyGostSegmentation`). The zone inspector now shows the room's required air exchange (category → м³/ч per СП 54/СП 60) with a category selector.

### Fixes

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
