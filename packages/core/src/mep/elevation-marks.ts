import type { DuctSectionProfile } from './aerodynamics'

/**
 * Общие helpers отметок оси/низа воздуховодов (Этап C4 PLAN-AGENT,
 * ГОСТ 21.602). Чистая логика: форматирование отметки в метрах с тремя
 * знаками и запятой («2,600»), вертикальная полувысота профиля для пересчёта
 * оси → низ, и подпись диапазона для группы участков. Используется DXF
 * (символ-уровень у трасс) и спецификацией (колонка «Отметка»).
 */

/** Отметка в метрах → «2,600» (запятая-разделитель, три знака). */
export function formatElevationM(meters: number): string {
  return meters.toFixed(3).replace('.', ',')
}

/** Вертикальная полувысота тела воздуховода, м: для круглого — D/2,
 *  для прямоугольного/плоско-овального — H/2 (H — вертикальная грань). */
export function profileVerticalHalfM(profile: DuctSectionProfile): number {
  if (profile.shape === 'round') return profile.diameterMm / 2000
  return profile.heightMm / 2000
}

/** Подпись отметки диапазоном: min === max → «2,600», иначе «2,600–3,000». */
export function elevationRangeLabel(minM: number, maxM: number): string {
  const lo = formatElevationM(minM)
  const hi = formatElevationM(maxM)
  return lo === hi ? lo : `${lo}–${hi}`
}
