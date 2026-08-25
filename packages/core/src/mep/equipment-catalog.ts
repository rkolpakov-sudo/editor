import { SUPPLY_EXHAUST_BALANCE_TOL_PCT } from './agent/flows'

/**
 * Каталог установок РФ и правила подбора (PLAN-AGENT §2.4, W7/W8):
 * рекомендация — совет со ссылками на нормы и статусами верификации,
 * а не решение за пользователя. Чистая логика над потребностями П/В:
 * приточная / вытяжная / приточно-вытяжная с рекуперацией / канальный
 * вентилятор / крышный вентилятор. Номинальный ряд установок — рабочий
 * (не норматив); статус верификации виден в панели.
 */

export type EquipmentCategory =
  | 'supply'
  | 'exhaust'
  | 'supply-exhaust-recovery'
  | 'ducted-fan'
  | 'roof-fan'

export type EquipmentRecommendation = {
  category: EquipmentCategory
  /** Русская подпись для панели. */
  label: string
  /** Расход подбора (большая из сторон / единственная сторона), м³/ч. */
  flowM3h: number
  /** Номинальный ряд установки, м³/ч. */
  nominalM3h: number
  reason: string
  notes: string[]
  references: string[]
}

export type EquipmentCatalogOptions = {
  /** Допуск дисбаланса П/В для рекомендации рекуператора, %.
   *  По умолчанию `SUPPLY_EXHAUST_BALANCE_TOL_PCT`. */
  balanceTolerancePercent?: number
  /** При расходе не больше этого значения канальный вентилятор вместо
   *  установки, м³/ч (рабочее значение). */
  ductedFanUpToM3h?: number
}

export const DEFAULT_DUCTED_FAN_UP_TO_M3H = 400

/** Номинальный ряд установок, м³/ч (рабочий, не норматив). */
export const EQUIPMENT_NOMINAL_ROWS_M3H = [
  100, 150, 200, 250, 300, 400, 500, 650, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6300,
  8000, 10000,
]

/** Ближайший номинал установки ≥ расхода (при расходе сверх ряда — максимум
 *  ряда, в notes попадает пометка). */
export function nearestEquipmentNominalM3h(flowM3h: number): number {
  for (const nominal of EQUIPMENT_NOMINAL_ROWS_M3H) {
    if (nominal >= flowM3h) return nominal
  }
  return EQUIPMENT_NOMINAL_ROWS_M3H[EQUIPMENT_NOMINAL_ROWS_M3H.length - 1]!
}

const REFS = [
  'СП 60.13330.2020 прил. М — подбор установок',
  'СП 54.13330.2022 — воздухообмен помещений',
  'статус верификации: TABLE_L3_VERIFIED=false (табл. Л.3 — допущение)',
]

/**
 * Подобрать оборудование по потребностям притока/вытяжки (м³/ч, обычно из
 * `computeZoneAirflows` по направлениям). Возвращает список рекомендаций
 * (пустой — данных нет). Детерминировано.
 */
export function recommendEquipment(
  supplyM3h: number,
  exhaustM3h: number,
  options: EquipmentCatalogOptions = {},
): EquipmentRecommendation[] {
  const tolerancePct = options.balanceTolerancePercent ?? SUPPLY_EXHAUST_BALANCE_TOL_PCT
  const ductedUpTo = options.ductedFanUpToM3h ?? DEFAULT_DUCTED_FAN_UP_TO_M3H
  const supply = Math.max(0, supplyM3h)
  const exhaust = Math.max(0, exhaustM3h)
  if (supply <= 0 && exhaust <= 0) return []

  const dominant = Math.max(supply, exhaust)
  const hasBoth = supply > 0 && exhaust > 0
  const imbalancePct = hasBoth
    ? (Math.abs(supply - exhaust) / Math.max(supply, exhaust)) * 100
    : null
  const balanced = imbalancePct !== null && imbalancePct <= tolerancePct

  const small = dominant <= ductedUpTo
  const refs = [...REFS]
  const notes: string[] = []

  if (hasBoth && balanced) {
    notes.push(
      `Баланс П/В ${imbalancePct!.toFixed(0)}% ≤ допуск ${tolerancePct}% — рекуперация энергоэффективна.`,
      'Приточная и вытяжная части одной установкой с рекуператором; байпас на летний режим.',
    )
    return [
      {
        category: 'supply-exhaust-recovery',
        label: 'Приточно-вытяжная установка с рекуперацией',
        flowM3h: dominant,
        nominalM3h: nearestEquipmentNominalM3h(dominant),
        reason: 'Обе системы есть, дисбаланс в допуске.',
        notes,
        references: refs,
      },
    ]
  }

  if (hasBoth && !balanced) {
    notes.push(
      `Дисбаланс ${imbalancePct!.toFixed(0)}% > допуск ${tolerancePct}% — раздельные установки с балансировкой клапанами.`,
    )
    return [
      {
        category: 'supply',
        label: 'Приточная установка',
        flowM3h: supply,
        nominalM3h: nearestEquipmentNominalM3h(supply),
        reason: 'Приток есть; вытяжка подбирается отдельно.',
        notes,
        references: refs,
      },
      {
        category: 'exhaust',
        label: 'Вытяжная установка',
        flowM3h: exhaust,
        nominalM3h: nearestEquipmentNominalM3h(exhaust),
        reason: 'Вытяжка есть; приток подбирается отдельно.',
        notes,
        references: refs,
      },
    ]
  }

  const onlySupply = supply > 0 && exhaust <= 0
  const sideLabel = onlySupply ? 'Приточная установка' : 'Вытяжная установка'
  const category: EquipmentCategory = onlySupply ? 'supply' : 'exhaust'
  const flow = onlySupply ? supply : exhaust

  if (small) {
    notes.push(
      `Расход ${dominant.toFixed(0)} м³/ч не больше ${ductedUpTo} — достаточно ${onlySupply ? 'канального вентилятора (нагнетателя)' : 'канального вентилятора (вытяжного)'}.`,
    )
    return [
      {
        category: 'ducted-fan',
        label: onlySupply ? 'Канальный вентилятор (приток)' : 'Канальный вентилятор (вытяжка)',
        flowM3h: flow,
        nominalM3h: nearestEquipmentNominalM3h(flow),
        reason: 'Малый расход — канальный вентилятор вместо установки.',
        notes: [
          ...notes,
          `Отсутствует ${onlySupply ? 'вытяжка' : 'приток'}: баланс П/В проверить нельзя — добавьте ${onlySupply ? 'вытяжную линию' : 'приточную линию'}.`,
        ],
        references: refs,
      },
    ]
  }

  notes.push(
    `Отсутствует ${onlySupply ? 'вытяжка' : 'приток'}: баланс П/В проверить нельзя — добавьте ${onlySupply ? 'вытяжную линию' : 'приточную линию'}.`,
    'Крышный вентилятор — вариант при размещении на кровле/техническом этаже (не автоматический выбор).',
  )
  return [
    {
      category,
      label: sideLabel,
      flowM3h: flow,
      nominalM3h: nearestEquipmentNominalM3h(flow),
      reason: onlySupply ? 'Есть только приток.' : 'Есть только вытяжка.',
      notes,
      references: refs,
    },
  ]
}
