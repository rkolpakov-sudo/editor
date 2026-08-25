import { describe, expect, test } from 'bun:test'
import { SUPPLY_EXHAUST_BALANCE_TOL_PCT } from './agent/flows'
import {
  DEFAULT_DUCTED_FAN_UP_TO_M3H,
  EQUIPMENT_NOMINAL_ROWS_M3H,
  nearestEquipmentNominalM3h,
  recommendEquipment,
} from './equipment-catalog'

describe('recommendEquipment — подбор установок РФ (§2.4, W7/W8)', () => {
  test('П и В в допуске → приточно-вытяжная с рекуперацией', () => {
    const recs = recommendEquipment(1000, 950)
    expect(recs).toHaveLength(1)
    const rec = recs[0]!
    expect(rec.category).toBe('supply-exhaust-recovery')
    expect(rec.flowM3h).toBe(1000)
    expect(rec.nominalM3h).toBe(1000)
    expect(rec.label).toContain('рекуперацией')
    expect(rec.reason).toContain('дисбаланс в допуске')
    expect(rec.notes[0]).toContain(`${SUPPLY_EXHAUST_BALANCE_TOL_PCT}%`)
    expect(rec.references.length).toBeGreaterThan(0)
  })

  test('дисбаланс сверх допуска → раздельные приточная и вытяжная', () => {
    const recs = recommendEquipment(1200, 400)
    expect(recs).toHaveLength(2)
    expect(recs.map((r) => r.category)).toEqual(['supply', 'exhaust'])
    expect(recs[0]!.flowM3h).toBe(1200)
    expect(recs[1]!.flowM3h).toBe(400)
    expect(recs.some((r) => r.category === 'supply-exhaust-recovery')).toBe(false)
    expect(recs[0]!.notes[0]).toContain('Дисбаланс')
  })

  test('только приток малого расхода → канальный вентилятор + подсказка про вытяжку', () => {
    const recs = recommendEquipment(300, 0)
    expect(recs).toHaveLength(1)
    expect(recs[0]!.category).toBe('ducted-fan')
    expect(recs[0]!.flowM3h).toBe(300)
    expect(recs[0]!.notes.some((note) => note.includes('канального вентилятора'))).toBe(true)
    expect(recs[0]!.notes.some((note) => note.includes('вытяжка'))).toBe(true)
  })

  test('только приток крупного расхода → приточная установка', () => {
    const recs = recommendEquipment(3000, 0)
    expect(recs).toHaveLength(1)
    expect(recs[0]!.category).toBe('supply')
    expect(recs[0]!.nominalM3h).toBe(3200)
    expect(recs[0]!.notes.some((note) => note.includes('Крышный вентилятор'))).toBe(true)
  })

  test('только вытяжка → вытяжная установка/канальный вентилятор', () => {
    const large = recommendEquipment(0, 2500)
    expect(large[0]!.category).toBe('exhaust')
    expect(large[0]!.nominalM3h).toBe(2500)

    const small = recommendEquipment(0, 150)
    expect(small[0]!.category).toBe('ducted-fan')
    expect(small[0]!.label).toContain('вытяжка')
  })

  test('порог канального вентилятора настраивается', () => {
    const defaultRecs = recommendEquipment(500, 0)
    expect(defaultRecs[0]!.category).toBe('supply')
    const lifted = recommendEquipment(500, 0, { ductedFanUpToM3h: 600 })
    expect(lifted[0]!.category).toBe('ducted-fan')
  })

  test('без потребностей — пустой список', () => {
    expect(recommendEquipment(0, 0)).toEqual([])
  })

  test('номинал округляется вверх, сверх ряда — максимум ряда', () => {
    expect(nearestEquipmentNominalM3h(251)).toBe(300)
    expect(nearestEquipmentNominalM3h(260)).toBe(300)
    expect(nearestEquipmentNominalM3h(100)).toBe(100)
    expect(nearestEquipmentNominalM3h(5000)).toBe(5000)
    expect(nearestEquipmentNominalM3h(99999)).toBe(
      EQUIPMENT_NOMINAL_ROWS_M3H[EQUIPMENT_NOMINAL_ROWS_M3H.length - 1],
    )
    void DEFAULT_DUCTED_FAN_UP_TO_M3H
  })
})
