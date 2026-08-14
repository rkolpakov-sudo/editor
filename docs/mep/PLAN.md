# ПЛАН: Профессиональный инструмент прокладки воздуховодов по нормам РФ

Дата: 14.08.2026. Статус: утверждён пользователем, реализация строго по этапам 0→7 (каждый этап завершается тестами).
**Все этапы 0–8 выполнены.** Целевой репозиторий: `pascalorg/editor` (монорепо Turborepo + Bun). Ветка разработки: `main`.
**Следующий блок — Этапы 9–13 (углубление): утка v2, спецификация и DXF v2, верификация норм, сквозная регрессия, публикация.** Реализация по той же схеме: каждый этап завершается тестами, перед переходом — `bun check` + `bun run check-types` + `bun test` зелёные.

## 1. Контекст и цель

Усилить MEP-инструмент прокладки трасс воздуховодов до профессионального уровня с привязкой к действующим
нормам РФ (аналог Revit/MagiCAD по workflow). Инструмент должен: рассчитывать сечения по СП 60 прил. Л,
маркировать системы П/В по ГОСТ 21.602, прокладывать трассы с учётом правил монтажа (СП 73),
автоопределять помещения по плану, автоматически разрешать пересечения приточных и вытяжных трасс
горизонтальным обводом (уткой) и формировать спецификацию по ГОСТ-номенклатуре.

**Стейкхолдер/пользователь**: проектировщик ОВиК РФ. **Язык интерфейса**: русский.

## 2. Текущее состояние кода (изучено)

| Область | Файлы | Состояние |
|---|---|---|
| Схема duct-segment | `packages/core/src/schema/nodes/duct-segment.ts` | path-полилиния [x,y,z] м; shape round/rect/oval; **размеры в мм по ГОСТ Р 70349** (diameter Ø100–2000 def 160; width/height 100–2000 def 400/200); system `supply\|return`; ductMaterial; roll |
| Схема duct-fitting | `packages/core/src/schema/nodes/duct-fitting.ts` | fittingType elbow/tee/cross/reducer/transition; angle 0–90°; branchAngle; shape/shape2; **мм** (Ø100–2000 def 315); system `supply\|return` |
| Параметрика фиттингов | `packages/nodes/src/duct-fitting/parametrics.ts` | derive/reconcile/onDelete; matedDucts по колларам; MATE_TOL_M=0.05; leg length = max(0.14, r×2.5) |
| Порты фиттингов | `packages/nodes/src/duct-fitting/ports.ts` | локальные порты (inlet/outlet/branch), конвенции XZ; getDuctFittingPorts |
| Геометрия/план фиттинга | `duct-fitting/{geometry,floorplan,definition}.ts` | def.geometry/floorplan, keyboardActions R/T rotate ±45°, axisCycling |
| Движок помещений | `packages/core/src/lib/space-detection.ts` | detectSpacesForLevel:2081, planAutoZonesForLevel:1688 (create/update/delete), resolveAutoZonePolygon, syncAutoSlabsForLevel, syncAutoZonesForLevel, live-синк :2204/:2353 |
| Зоны | `packages/core/src/schema/nodes/zone.ts` | autoFromWalls, boundaryWallIds, enclosureStatus, spaceRole, roomNumber, occupancy, ceilingHeight; **spaceCategory** (по СП, default `public`) |
| Видимость зон | `packages/editor/src/components/systems/zone/zone-system.tsx`, `viewer-zone-system.tsx` | room-зоны видны в любом structureLayer; generic-зоны — только в режиме zones |
| Расчётный движок вентиляции | `packages/core/src/mep/*` | ✅ **Этап 3 выполнен** (см. ниже): constants, norms-types, aerodynamics, sizing, routing-rules, duct-network |
| Undo/Redo | `packages/editor/src/lib/history.ts` | runUndo/runRedo, useEditor; Ctrl+Z/Ctrl+Shift+Z; кнопки в тулбаре |
| Экспорт/IFC/MCP | `apps/ifc-converter`, `packages/mcp/src/tools/*` | базовые тулзы |
| Архитектура | `wiki/architecture/README.md` (21 страница) | слои: core (без Three), viewer (канвас), editor (UX); registry-driven (def.geometry/renderer/system) |

**Критичный архитектурный факт**: расчётный движок, номенклатура и правила живут в `packages/core`
(чистая логика, без Three.js); геометрия/рендер — в `packages/nodes` и `packages/viewer`;
UI — в `packages/editor` / `apps/editor`.

## 3. Решения пользователя (зафиксированы голосованиями)

**Базовые:**
- Объём: **все этапы сразу** (данные → расчёт → UI → документация/экспорт).
- Нормы: **универсальные** — жилые + общественные + промышленные (СП 60 прил. Л, СП 54, СП 56, СП 73).
- Единицы: **полный переход на мм + ГОСТ-ряд**.
- Авто-зоны: **полностью автоматически** из замкнутых контуров стен.
- Авто-зона **удаляется при размыкании контура**.
- Помещения **видны по умолчанию** без слоя zones.

**Обвод пересечений П/В:**
- Модель: **горизонтальный обвод в плане (утка)** — обе трассы на одной отметке, вытяжная обходит приточную.
- Приоритет: **приток идёт прямо**, обход строит вытяжная.
- Зазор между корпусами: **≥ 50 мм**.
- Инструмент: **автоопределение + автопостроение**.
- Номенклатура: **универсальный ряд по ГОСТ-параметрам** (отводы 90°/45° R=1.5D, утка, переход, тройник).
- Расчёт: **пересчёт потерь на обводе**.
- Угол утки: **автовыбор 45°/90°** (по умолчанию 45°, при нехватке места — 90° с подсказкой).
- Маркировка: **supply / exhaust / return** (П/В/рециркуляция).

## 4. Справочник норм (кратко; полные таблицы — в `docs/mep/00..05`)

- Скорости: СП 60 прил. Л — табл. Л.1 (вытяжные) и Л.2 (приточные) по расходу и часам работы; Л.3 (жилые) — рабочий дефолт ≤5 м/с магистрали, 2–3 ответвления.
- Зона обитания: 0,10–0,15 оптимум / до 0,25–0,30 допустимо (ГОСТ 30494). Шум: >5–6 м/с → акустика.
- Формулы: v=Q/(3600·F); d=√(4F/π); d_экв(площадь)=√(4ab/π); d_экв(сопротивление)=2ab/(a+b).
- Воздухообмен: кухня газ 90 / электр 60, ванная 25, туалет 25, совмещённый 50, жилые 3 м³/ч·м²; офис 20/60 м³/ч/чел.
- Номенклатура: круглые Ø100–2000; прямоугольные до 2000×2000; длины 0,5/1,0/1,25/2,0/2,5 м; отводы 90/45/30/15° R=1D и 1.5D; утка/переход/тройник/крестовина/седелка/зонт.
- Монтаж: крепления (круглые ≤400 → 4 м, >400 → 3 м; прямоуг. → 3 м; верт. → 3,5–4 м); гильзы с негорючим уплотнением; противопожарные клапаны на преградах.

## 5. Закрытие 7 замечаний к плану v2

| № | Замечание | Как закрывается |
|---|---|---|
| 1 | Нормы РФ не изучены, нет справочника | `docs/mep/00..05` + раздел 4 плана |
| 2 | Нет правил прокладки трасс | routing-rules: крепления, отступы, проходы, обвод |
| 3 | Нет автоподбора сечения на каждом участке | aerodynamics/sizing по СП 60 прил. Л, итерация по участкам |
| 4 | Нет различия/маркировки приток/вытяжка | system supply/exhaust/return + маркировка П1/В1 по ГОСТ 21.602 |
| 5 | Нет проходов через стены по нормам | гильзы/футляры, клапаны на преградах |
| 6 | Нет круглых и прямоугольных воздуховодов | shape round/rect + переход; ГОСТ Р 70349 |
| 7 | Нет автоделения трассы по номенклатуре ГОСТ | авто-сегментация по длинам 0,5/1,0/1,25/2,0/2,5 м + фитинги |

## 6. Детальный план реализации (этапы 0–7)

### Этап 0 — Справочник и документация (выполнен)
- `docs/mep/00..05` + этот PLAN.md. ✅ (коммит вместе с планом)

### Этап 1 — Миграция единиц: дюймы → мм + ГОСТ-ряд (выполнен)
- Обратная совместимость: schemaVersion 1→2; на чтении конвертировать старые дюймы (×25.4) в мм,
  помечая `metadata.migratedFromInches=true`; на записи — новые мм. ✅ `packages/core/src/utils/duct-units-migration.ts`,
  вызывается в `migrateNodes` (после `migrateVerticalSceneNodes`); идемпотентность по маркеру (2″→50.8 < 100 — value-проверка небезопасна).
- `duct-segment.ts`: `diameter`/`width`/`height` — мм; диапазоны по ГОСТ (Ø100–2000, def 160/400/200). ✅
- `duct-fitting.ts`: те же поля в мм (Ø100–2000, def 315/400/200). ✅
- Инспекторы/HUD в `packages/nodes/src/duct-segment/*`, `duct-fitting/*` — единицы «мм», степпинг 5 мм, ГОСТ-ряд в тулбаре (`DUCT_DIAMETERS_MM`). ✅
- Порты фиттингов рекламируют `diameter` в дюймах (кросс-видовая конвенция) — `/25.4` на выходе. ✅
- Коммиты: `7f1aede5` (core), `31a7060f` (nodes).

### Этап 2 — Авто-зоны помещений (используем готовый движок) (выполнен)
- Привязать `planAutoZonesForLevel` (create/update/delete) + live-синк (размыкание контура → авто-зона удаляется). ✅
  `planAutoZonesForLevel` (`space-detection.ts`) теперь возвращает `{create, update, delete}`:
  для каждого детектированного space создаётся авто-зона (`autoFromWalls`, `spaceRole:'room'`, имя «Room N»),
  авто-зона без соответствующего space удаляется (контур разомкнут), ручные зоны не трогаются.
  Подключено через `syncAutoZonesForLevel` в оба пути детекции (`runSpaceDetection`, `runIndexedSpaceDetection`).
  Авто-зоны попадают в тот же undo-коммит, что и правка стены.
- Видимость по умолчанию: комнаты видны без слоя zones. ✅ `zone-system.tsx` / `viewer-zone-system.tsx`:
  room-зоны (`spaceRole:'room'` или `autoFromWalls`) показываются в любом structureLayer; generic-зоны (газон/вода) — только в режиме zones.
- `zone.ts`: добавить `spaceCategory` (по СП: kitchen_gas/kitchen_electric/bath/toilet/combined_wc/living/office_short/office_permanent/public/industrial), связать с таблицей воздухообмена. ✅
  `SPACE_CATEGORIES` + поле `spaceCategory` (default `'public'`) + экспорт типа из `schema/index.ts`;
  значения соответствуют таблице `docs/mep/01-air-exchange-residential.md`.

### Этап 3 — Модель данных расчёта (`packages/core`, чистая логика) (выполнен)
Новый модуль `packages/core/src/mep/`:
- `constants.ts` — скорости прил. Л (таблицы Л.1/Л.2 как `recommendedVelocityRange`, рабочий дефолт Л.3 с `TABLE_L3_VERIFIED = false`), воздухообмен по типам помещений (`AIR_EXCHANGE_RATES` + `resolveRequiredAirflowM3h`), ряды размеров ГОСТ (`ROUND_DUCT_SIZES_MM`, `RECT_SIDE_ROW_MM`), длины сегментов, зазор 50 мм (`BYPASS_MIN_GAP_MM`), шаги креплений, физ. константы воздуха. ✅
- `norms-types.ts` — `SpaceCategory` (re-export из zone.ts), `SystemType` (supply/exhaust/return), `SheetType`, `AnnualHoursBand`, `BuildingClass`, `ResidentialSection`, `DuctShape`. ✅
- `aerodynamics.ts` — v=Q/(3600F), d=√(4F/π), d_экв (по площади и по сопротивлению, d_h=4A/P для всех форм), ξ отводов (таблица по углу/R с интерполяцией), ΔP = Σ(R·l + Z), Z=ξ·(ρv²/2), λ (ламинарный/Блазиус), N=Q·ΔP/(3600·η). ✅
- `sizing.ts` — автоподбор диаметра/прямоугольника на **каждом участке** по СП 60 прил. Л с привязкой к ГОСТ-ряду (smallest in-band, переподбор при нехватке). ✅
- `routing-rules.ts` — правила прокладки: крепления (`mountingSpacingM`/`supportCountForRun`), проходы через стены (`checkWallPenetration` — гильза + негорючее уплотнение), противопожарные клапаны (`checkFireBarrierCrossing`), планарные примитивы пересечений. ✅
- `duct-network.ts` — расширение system-graph: группировка компонентов в сети П/В/return, маршрутизация, валидация (`open-run-end`, `unconnected-terminal`, `orphaned-network`, `mixed-systems`). Выделен в `mep/` (переиспользует `buildPortComponents`/`summarizeSystemFor`), чтобы не менять существующий `services/system-graph.ts`. ✅
- `bypass.ts` — сервис автообвода, **см. Этап 4** (в Этапе 3 заложены примитивы пересечений в `routing-rules.ts` и константа зазора).

### Этап 4 — Обвод пересечений П/В (утка) — автоопределение + автопостроение (выполнен)
Сервис `packages/core/src/mep/bypass.ts` (чистая логика, без Three): ✅
1. Обнаружение: планарная проверка пересечения полилиний supply vs exhaust (отрезки, допуск),
   исключение стыков на концах и трасс на разных отметках (`VERTICAL_CONFLICT_TOL_M`). ✅
2. Приоритет: supply (П) прямая; кандидат на обход — exhaust (В). ✅
3. Геометрия: S-образный обход ⊥ своей оси (= ⊥ приточной при перпендикулярном пересечении);
   смещение = ширина/диаметр приточной + **2×50 мм** (`BYPASS_MIN_GAP_MM`). ✅
4. Угол: 45° (R=1.5D) по умолчанию; автопереключение на 90° при нехватке длины + флаг `autoSwitchedTo90`. ✅
5. Построение: разбить вытяжной сегмент на под-участки (before/after), вставить фиттинг
   `fittingType: 'offset'` (утка: 2 отвода + наклонный + параллельный, возврат на ось).
   Результат — цепочка segment/fitting. ✅ `planBypass` → `buildBypassMutations`.
6. Аэродинамика: пересчёт длины, Σξ = 2 отвода, ΔP = Σ(R·l + Z), переподбор диаметра по ГОСТ-ряду
   (`BypassAero` при `flowM3h`). ✅
7. Undo/redo: через командный слой (checkpoint до мутаций) — готово для Этапа 5 (UI). ✅ (подготовлено)

Изменения схемы:
- `duct-segment.ts` / `duct-fitting.ts`: `system: 'supply' | 'exhaust' | 'return'`. ✅
- `duct-fitting.ts`: `fittingType: 'offset'` (утка) + поля `offset` (мм), `angle` (45/90),
  `offsetRadiusFactor` (R/D, по умолчанию 1.5). ✅
- `duct-fitting/{ports,geometry,floorplan,parametrics,definition}.ts`: порты (на оси, ±полу-пролёт),
  S-геометрия по общей `computeBypassGeometry`, план, инспектор утки. ✅
- Тесты: `packages/core/src/mep/bypass.test.ts` — 15 (пересечение, угол 45/90, зазор ≥50 мм,
  приоритет П/В, split, аэродинамика, мутации). ✅

### Этап 5 — UI инструментов (`packages/editor` / `apps/editor` / `packages/nodes`) (выполнен)
- Панель «Вентиляция» (аналог `riser-diagram-panel.tsx`): список систем П/В (сети из `buildDuctNetworks`),
  маркировка П1/В1 по ГОСТ 21.602, кнопка «Автообвод пересечений», сводка потерь, замечания связности
  (`validateDuctNetwork`). ✅ `ventilation-panel.tsx`, тумблер в тулбаре (`viewer-toolbar.tsx` / `view-toggles.tsx`),
  монтируется в оверлеях v1 и v2. Автообвод применяет все планы одной командой (`applyNodeChanges` — один undo-шаг).
- Маркировка П1/В1 по ГОСТ 21.602 в HUD и на плане; цветовая дифференциация систем
  (П оранжевый / В зелёный / Р синий). ✅ `planSystemMarkings` (нумерация сетей внутри системы),
  `computeFloorplanLevelData` + label `kind:'text'` на участке, легенда в панели.
- Инспектор участка: расход, скорость, диаметр по ГОСТ, ΔP, длина сегментов по ГОСТ, кол-во креплений. ✅
  `duct-segment/mep-panel.tsx` (trailingSection) — разбивка по ГОСТ, подбор по СП 60, кнопка «Разбить по ГОСТ».
- Инспектор зоны: тип помещения → «N м³/ч». ✅ `zone/quantities-panel.tsx` — секция «Вентиляция»:
  категория по СП (`spaceCategory`), норма, требуемый расход (`resolveRequiredAirflowM3h`), направление П/В.
- Авто-сегментация: кнопка «Разбить по ГОСТ» (дробление path на стандартные длины + фитинги). ✅
  `gost-segmentation.ts` (`planGostSegmentation`/`planGostSplit`), применение одной командой.
- Подсказки при автопереключении 45°→90°. ✅ бейдж «45→90°» + сводка в панели, флаг `autoSwitchedTo90`.
- Тесты: `mep/gost-segmentation.test.ts` (13), `editor/lib/mep-actions.test.ts` (4). ✅

### Этап 6 — Экспорт и документация (выполнен)
- Спецификация: ведомость материалов (воздуховоды, отводы, утки, переходы, тройники, клапаны, крепления) по ГОСТ-номенклатуре. ✅ `packages/core/src/mep/specification.ts`
  (`buildDuctSpecification` — группировка по профилю/системе, разбивка на звенья ГОСТ, фитинги, решётки,
  крепления, гильзы и противопожарные клапаны из пересечений со стенами; `specificationToCsv`/`specificationToText`).
- DXF (план, маркировка П/В). ✅ `packages/core/src/mep/dxf.ts` (`ductsToDxf` — ASCII DXF: участки на слоях
  систем П/В/Р, фитинги кругами, решётки квадратами, маркировка П1/В1/Р1 по ГОСТ 21.602).
- UI: секция «Спецификация» в панели «Вентиляция» (таблица + кнопки «Скачать CSV» / «Скачать DXF»). ✅
- MCP: тулзы `mep_specification` и `mep_dxf`; `describe_node` описывает duct-узлы (система, размеры мм, длина). ✅
- IFC: `apps/ifc-converter` — импорт IFC→Pascal (однонаправленный), экспорт Pascal→IFC в репозитории отсутствует;
  поля систем и результаты расчёта несут узлы duct (`system`) и MCP-тулзы экспорта. ✅ (документировано)

### Этап 7 — Тесты (выполнен)
- Unit: аэродинамика/подбор (по таблицам Л.1/Л.2), bypass (пересечение, угол, зазор 50, приоритет П/В), миграция дюймы→мм, авто-зоны (размыкание→удаление), спецификация. ✅
  - `mep/aerodynamics.test.ts` (16), `sizing.test.ts` (9), `constants.test.ts` (11) — Л.1/Л.2, подбор по ГОСТ-ряду;
  - `mep/bypass.test.ts` (15) — пересечение, 45°/90°, зазор ≥50 мм, приоритет П/В, split, аэродинамика;
  - `utils/duct-units-migration.test.ts` (6) — миграция дюймы→мм, идемпотентность;
  - `lib/space-detection.test.ts` — авто-зоны: create/update/delete, **размыкание контура → удаление**;
  - `mep/specification.test.ts` (11), `gost-segmentation.test.ts` (13), `routing-rules.test.ts` (10), `duct-network.test.ts` (9), `dxf.test.ts` (8).
- Integration: «план → зоны → трассы П/В → пересечение → автообвод → расчёт → спецификация». ✅
  `mep/pipeline.test.ts` (7) — полный пайплайн одной сценой: замкнутый контур стен → авто-зона
  (`detectSpacesForLevel`/`planAutoZonesForLevel`), категория по СП 54 → норматив (кухня 90 м³/ч),
  П/В трассы → `detectBypassCrossings`, утка (`planAllBypasses`+`buildBypassMutations`, смещение
  supply + 2×50 мм, повторный проход 0 конфликтов), `sizeDuctSection` по Л.1, спецификация
  (`buildDuctSpecification` — системы П1/В1, утка в фасонных частях, 4 гильзы, крепления, масса).
- Проверки: `bun check` (Biome) — чисто; `bun run check-types` — 10/10; `bun test` — 3182 pass / 1 skip / 0 fail.

---

### Этап 8 — Сетевой расчёт: воздухообмен и потери по всей сети (выполнен)

**Цель**: перейти от «расчёта одного участка» (`sizeDuctSection`) к расчёту всей сети П/В —
воздухообмен по помещениям, пропагация расходов, суммарные потери и балансировка ответвлений.
Новые модули в `packages/core/src/mep/` (чистая логика, без Three.js):

1. **Воздухообмен зон → расходы трасс** (`air-exchange.ts`): ✅
   `polygonAreaM2`/`zoneCentroid` (площадь и центр комнаты по полигону зоны),
   `computeZoneAirflows` (СП 54 + `resolveRequiredAirflowM3h`, направление П/В из таблицы),
   `assignZoneAirflowsToTerminals` (жадное назначение каждой комнаты в ближайший
   совместимый терминал: приток → диффузор/решётка, вытяжка → вытяжная решётка),
   `terminalFlowMap` (несколько зон на один терминал складываются).
2. **Пропагация расходов по сети** (`network-flows.ts`): ✅
   `buildDuctNetworkGraphs` — общий граф сети по совпавшим портам
   (`collectPortRecords`/`matedPortGroups` из `duct-network`): узлы-соединения, смежность,
   остовное дерево от корня; корень — оборудование (установка), без него — узел с
   максимальной степенью (флаг `rootedAtEquipment`). `computeNetworkFlows` прокачивает
   Q от терминалов к магистрали: расход участка = сумма терминалов в поддереве от корня;
   на выходе `segmentId → flowM3h`, `totalFlowM3h`, статус терминалов.
3. **Сетевые потери и балансировка** (`network-pressure.ts`): ✅
   для каждой сети пути от оборудования до каждого терминала: ΣΔP по пути
   (`pressureDropPa` по участкам + ξ фитингов — отводы `elbowZeta`, утка 2×ξ отвода,
   тройники/крестовины `teeZeta` (проход/ветка по порту соединения), переходы
   `transitionZeta`), критический путь (max ΔP), балансировка ответвлений на узлах
   ветвления (расхождение ≤ `BRANCH_BALANCE_TOLERANCE_PCT=15%`, помечено рабочим
   значением до верификации по СП 60 — флаг `FITTING_ZETA_VERIFIED=false`).
4. **Подбор диаметров по сети** (`network-sizing.ts`): ✅
   участки каждой сети в порядке «магистраль → ответвления» (BFS от корня), каждый —
   `sizeDuctSection` под свой расход/систему; результат с профилем ГОСТ, скоростью,
   ΔP по трению, флагом норм-диапазона и шумовой проверки; `sizedProfiles` →
   карта для пересчёта потерь по подобранным сечениям.
5. **UI**: ✅ панель «Вентиляция» → секция «Расчёт сети»: сводка по системам
   (ΣQ, критический путь ΔP, число путей, бейдж разбалансировки), таблица
   «участок → С, Q, сечение ГОСТ, v, ΔP», подсветка участков с `noiseCheckRequired`
   или выходом за диапазон, предупреждения балансировки/шума.
6. **Тесты**: ✅ `mep/air-exchange.test.ts` (9), `mep/network-flows.test.ts` (5),
   `mep/network-pressure.test.ts` (5), `mep/network-sizing.test.ts` (4) +
   интеграция в `pipeline.test.ts` (кухня 90 → расход на участках → подбор Ø100 → ΔP).
   Общий тест-стаб `mep/duct-network-stubs.ts` (конвенции портов без packages/nodes).
   Проверки: `bun check` (Biome) чисто, `bun run check-types` 10/10, `bun test` — 3207 pass / 1 skip / 0 fail.

### Этап 9 — Утка v2: обход по сети, зазор при вертикальных участках, косые пересечения (в работе)

**Цель**: закрыть пробелы `bypass.ts` Этапа 4, выявленные при углублении:

1. **Пропагация обвода по сетям**: `detectBypassCrossings` сейчас итерирует по «сырым» сегментам
   и не учитывает фиттинги/терминалы; перевести на звенья сетей (`buildDuctNetworks`), чтобы обвод
   корректно работал на трассе «магистраль + ответвления» и не путал вложенные тройники.
2. **Обход нескольких пересечений одной вытяжки**: сейчас `applyAllBypasses` пропускает повторные
   пересечения на одном и том же exhaust-сегменте (`touchedExhaustIds`); планировать **все**
   пересечения участка сразу (последовательность уток вдоль одной трассы, а не первая только).
3. **Зазор по вертикали**: `VERTICAL_CONFLICT_TOL_M=0.1` жёсткий; при разной отметке трасс
   (пересечение в плане, но разной высоте) — добавлять проверку фактического вертикального зазора
   между корпусами (диаметр/высота + 50 мм) и не строить утку, если зазор уже достаточен.
4. **Косые пересечения**: `segmentSegmentIntersection` работает для любых углов, но сторона обхода
   всегда `'left'`; выбирать сторону автоматически по доступной длине прямой слева/справа от точки
   пересечения (взять ту, где больше `runIn`/`runOut`), и пробовать обе стороны при `no-room`.
5. **ξ утки через общий эльбо-таблицу**: вынести ξ отводов в `constants.ts`/`aerodynamics.ts`
   (сейчас захардкожен `ELBOW_ZETA`), чтобы спецификация и утка использовали один источник.
6. **Тесты**: расширить `bypass.test.ts` (несколько пересечений одной вытяжки, вертикальный зазор,
   автовыбор стороны, утка на сети с тройником) + `pipeline.test.ts`.

### Этап 10 — Спецификация v2 и DXF v2 (в работе)

**Цель**: довести экспорт до рабочего документа по ГОСТ 21.602/Р 70349.

1. **Спецификация v2** (`specification.ts`):
   - Разбивка на звенья ГОСТ — уже есть (`planGostSegmentation`); добавить **массу звена** по длине
     и периметру (сегодня масса только в сводке), и **гильзы/клапаны по местам прохода** (уже есть).
   - Связать расходы/подбор из Этапа 8 в строки воздуховодов (Ø подобран, длина, звенья).
   - В позиции «Фасонные части» группировать по типу/размеру (отводы 90/45 R=1.5D, утки, тройники)
     — сейчас группировка по `fittingType|system|name`, добавить размер к ключу.
2. **DXF v2** (`dxf.ts`):
   - Рисовать фиттинги не кругами, а по типу (отвод — дуга, утка — S-полилиния из
     `computeBypassGeometry.keyPointsLocal`, тройник — линия+ответвление), с размерами мм в тексте.
   - Добавить **маркировку П1/В1/Р1 на каждом участке** (уже есть) + **таблицу/легенду** систем.
   - Показывать **отверстия/проходы через стены** (гильзы) точками на пересечении с `walls`.
   - Слои/цвета по системам уже есть; добавить слой «Гильзы/клапаны».
3. **Тесты**: расширить `specification.test.ts` (масса звеньев, размер в группировке фиттингов) и
   `dxf.test.ts` (утка как полилиния, гильзы на стенах, размеры в маркировке).

### Этап 11 — Верификация норм и параметров (в работе)

**Цель**: закрыть «рабочие» допущения, помеченные `_VERIFIED = false`/дефолтами, подтвердив по
первоисточникам и задокументировав в `docs/mep/05-sources-log.md`:

| Параметр | Где | Текущий статус | Действие |
|---|---|---|---|
| Таблица Л.3 (жилые) | `constants.ts` `RESIDENTIAL_VELOCITY_DEFAULTS`, `TABLE_L3_VERIFIED=false` | Рабочий дефолт (магистрали ≤5, ответвления 2–3) | Попытаться получить полный текст СП 60 (платный); если нет — задокументировать как допущение с обоснованием |
| Шаг креплений СП 73 | `constants.ts` `MOUNTING_SPACING_VERIFIED=false`, `routing-rules.mountingSpacingM` | Круг ≤400→4 м, >400→3 м, прямоуг→3 м | Сверить с полным текстом СП 73; пометить источник |
| ξ отводов | `aerodynamics.ts` `ELBOW_ZETA` | Справочные значения с интерполяцией | Сослаться на первоисточник (справочник проектировщика ОВиК), добавить ссылку в docstring |
| Зазор 50 мм П/В | `BYPASS_MIN_GAP_MM=50` | Решение пользователя | Зафиксировано в `04-routing-bypass-practice.md` — ок |
| Скорости в зоне обитания | `OCCUPIED_ZONE_VELOCITY` | ГОСТ 30494 | Подтверждено — ок |

### Этап 12 — Сквозная проверка и регрессия (в работе)

**Цель**: прогнать весь новый функционал Этапов 8–11 на одной сцене и убедиться в отсутствии
регрессий существующих инструментов.

1. **Интеграционный тест v2**: расширить `mep/pipeline.test.ts`: комната (кухня) → авто-зона →
   категория → расход 90 → трассы П/В → пересечение → утка → **сетевой подбор (Этап 8)** →
   спецификация v2 → DXF v2. Утверждения: расход на участке = 90, Ø100/125 по ГОСТ, ΔP>0,
   утка в фасонных частях, маркировка П1/В1.
2. **Регрессия**: `bun test` (все 3183), `bun run check-types` (10/10), `bun check` (Biome) — чисто.
3. **Ручная проверка в UI**: панель «Вентиляция» на сцене с комнатой и двумя пересекающимися
   трассами — автообвод, спецификация, DXF скачивается, маркировка на плане.

### Этап 13 — (при необходимости) Публикация

- Собрать изменения Этапов 8–12 в ветку `feat/mep-network` от `main`, PR в форк
  `rkolpakov-sudo/editor` (по правилу коммитов из `AGENTS.md` — только в форк, не в origin).
- Обновить `CHANGELOG.md` (секция Unreleased) и `AGENTS.md` (статус MEP).
- Прогнать `bun check`/`bun run check-types`/`bun test` перед PR.

## 7. Файлы, которые будут затронуты

- `packages/core/src/schema/nodes/{duct-segment,duct-fitting,zone}.ts`
- `packages/core/src/utils/duct-units-migration.ts` (миграция дюймы→мм; сделано)
- `packages/core/src/mep/*` (сделано: constants, norms-types, aerodynamics, sizing, routing-rules, bypass, duct-network, gost-segmentation, specification, dxf, air-exchange, network-flows, network-pressure, network-sizing, duct-network-stubs, pipeline.test)
- `packages/core/src/mep/{air-exchange,network-flows,network-pressure,network-sizing}.ts` (новые, Этап 8 — сделано)
- `packages/core/src/mep/*.test.ts` (Этап 8: air-exchange, network-flows, network-pressure, network-sizing; расширения bypass/specification/dxf/pipeline.test)
- `packages/core/src/services/system-graph.ts`, `packages/core/src/lib/space-detection.ts`
- `packages/nodes/src/duct-fitting/{schema,ports,parametrics,geometry,floorplan,definition}.ts`
- `packages/nodes/src/duct-segment/*`
- `packages/editor/src/components/viewer-zone-system.tsx`, `zone-tool.tsx`, `quantities-panel.tsx`, `riser-diagram-panel.tsx`, `viewer-toolbar.tsx`
- `packages/editor/src/components/editor/ventilation-panel.tsx` (таблица «участок → расход/Ø/v/ΔP», Этап 8)
- `apps/ifc-converter`, `packages/mcp/src/tools/*`
- `docs/mep/*` (справочник; `05-sources-log.md` — верификация Этапа 11)

## 8. Проверки на каждом этапе

- `bun check` — Biome lint/format. ✅ (чисто на всех этапах)
- `bun run check-types` — typecheck. ✅
- `bun test` — unit/integration. ✅ (итог Этапа 7: 3182 pass / 1 skip / 0 fail; итог Этапа 8: 3207 pass / 1 skip / 0 fail)
- Перед переходом к следующему этапу — все тесты зелёные. ✅