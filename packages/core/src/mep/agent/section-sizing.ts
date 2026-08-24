import {
  type DuctSectionProfile,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  frictionPressureDropPerMeterPa,
  velocityMps,
} from '../aerodynamics'
import { NOISE_VELOCITY_THRESHOLD_MS, recommendedVelocityRange } from '../constants'
import type { AnnualHoursBand, BuildingClass, ResidentialSection, SystemType } from '../norms-types'
import {
  EQUAL_FRICTION_DEFAULT_PA_PER_M,
  nearestRoundDuctSizeMm,
  roundDiameterForFrictionM,
  sizeDuctSection,
} from '../sizing'
import type { AgentFlowsResult } from './flows'
import type { RecognizedTopology } from './recognize-topology'

/**
 * Этап 3 конвейера агента автотрассировки (PLAN-AGENT §2.2): подбор сечений
 * путям распознанной топологии по их расходам из Этапа 2. Два метода —
 * скоростной по СП 60 прил. Л (`sizeDuctSection`) и равных потерь
 * (`roundDiameterForFrictionM`); оба snapают результат на ГОСТ Р 70349.
 * Сечение круглое (форма — предпочтение трассировки этапа B4). Чистая логика.
 */

const FLOW_EPS = 1e-6

export type AgentSizingMethod = 'velocity-sp60' | 'equal-friction'

export type AgentSizingOptions = {
  /** Метод подбора; по умолчанию скоростной СП 60. */
  method?: AgentSizingMethod
  /** Целевые удельные потери для равных потерь, Па/м
   *  (по умолчанию `EQUAL_FRICTION_DEFAULT_PA_PER_M`). */
  frictionPaPerM?: number
  hoursBand?: AnnualHoursBand
  buildingClass?: BuildingClass
  residentialSection?: ResidentialSection
  /** Жёсткий предел скорости (акустика) поверх норм-диапазона СП 60. */
  maxVelocityMps?: number
}

export type SizedAgentPath = {
  pathIndex: number
  sourceRunIndex: number
  system: SystemType
  flowM3h: number
  /** ГОСТ-профиль участка; null — расход нулевой, сечение не назначено. */
  profile: DuctSectionProfile | null
  velocityMps: number
  inNormBand: boolean
  noiseCheckRequired: boolean
  /** Удельные потери трения подобранного сечения, Па/м. */
  frictionPaPerM: number
}

export type AgentSizingIssueCode = 'zero-flow-path' | 'unsizable-flow'

export type AgentSizingIssue = {
  severity: 'warning'
  code: AgentSizingIssueCode
  message: string
  pathIndex?: number
}

export type AgentSizingResult = {
  paths: SizedAgentPath[]
  issues: AgentSizingIssue[]
}

/** Подобрать сечения всем путям топологии по их расходам (Этап 2). */
export function sizeAgentPaths(
  topology: RecognizedTopology,
  flows: AgentFlowsResult,
  options: AgentSizingOptions = {},
): AgentSizingResult {
  const method = options.method ?? 'velocity-sp60'
  const targetFriction = options.frictionPaPerM ?? EQUAL_FRICTION_DEFAULT_PA_PER_M
  const flowByPath = new Map(flows.paths.map((path) => [path.pathIndex, path.flowM3h]))
  const issues: AgentSizingIssue[] = []

  const paths: SizedAgentPath[] = topology.paths.map((path, pathIndex) => {
    const flowM3h = flowByPath.get(pathIndex) ?? 0
    if (flowM3h <= FLOW_EPS) {
      if (flowM3h < -FLOW_EPS) {
        issues.push({
          severity: 'warning',
          code: 'unsizable-flow',
          message: `Полилиния №${path.sourceRunIndex + 1} (${path.system}): отрицательный расход ${flowM3h.toFixed(0)} м³/ч — сечение не назначено.`,
          pathIndex,
        })
      } else {
        issues.push({
          severity: 'warning',
          code: 'zero-flow-path',
          message: `Полилиния №${path.sourceRunIndex + 1} (${path.system}): нулевой расход — проверьте привязку терминалов.`,
          pathIndex,
        })
      }
      return {
        pathIndex,
        sourceRunIndex: path.sourceRunIndex,
        system: path.system,
        flowM3h,
        profile: null,
        velocityMps: 0,
        inNormBand: true,
        noiseCheckRequired: false,
        frictionPaPerM: 0,
      }
    }

    let profile: DuctSectionProfile | null = null
    let velocity = 0
    let inNormBand = true
    let noiseCheckRequired = false

    if (method === 'velocity-sp60') {
      const sizing = sizeDuctSection({
        flowM3h: flowM3h,
        system: path.system,
        shape: 'round',
        hoursBand: options.hoursBand,
        buildingClass: options.buildingClass,
        residentialSection: options.residentialSection,
        maxVelocityMps: options.maxVelocityMps,
      })
      if (!sizing) {
        issues.push({
          severity: 'warning',
          code: 'unsizable-flow',
          message: `Полилиния №${path.sourceRunIndex + 1} (${path.system}): расход ${flowM3h.toFixed(0)} м³/ч не покрывается ГОСТ-рядом — сечение не назначено.`,
          pathIndex,
        })
      } else {
        profile = sizing.profile
        velocity = sizing.velocityMps
        inNormBand =
          velocity >= sizing.recommendedVelocity.min && velocity <= sizing.recommendedVelocity.max
        noiseCheckRequired = sizing.noiseCheckRequired
      }
    } else {
      const requiredDiameterM = roundDiameterForFrictionM(flowM3h, targetFriction)
      if (requiredDiameterM === null) {
        issues.push({
          severity: 'warning',
          code: 'unsizable-flow',
          message: `Полилиния №${path.sourceRunIndex + 1} (${path.system}): метод равных потерь неприменим при расходе ${flowM3h.toFixed(0)} м³/ч.`,
          pathIndex,
        })
      } else {
        profile = { shape: 'round', diameterMm: nearestRoundDuctSizeMm(requiredDiameterM) }
        velocity = velocityMps(flowM3h, ductSectionAreaM2(profile))
        // Метод равных потерь сам не нормирует скорость — диапазон СП 60
        // приводится справочно, как в Revit.
        const band = recommendedVelocityRange(
          path.system,
          flowM3h,
          options.hoursBand,
          options.buildingClass,
          options.residentialSection,
        )
        inNormBand = velocity >= band.min && velocity <= band.max
        noiseCheckRequired = velocity > NOISE_VELOCITY_THRESHOLD_MS
      }
    }

    const frictionPaPerM =
      profile && velocity > 0
        ? frictionPressureDropPerMeterPa(ductSectionHydraulicDiameterM(profile), velocity)
        : 0

    return {
      pathIndex,
      sourceRunIndex: path.sourceRunIndex,
      system: path.system,
      flowM3h,
      profile,
      velocityMps: velocity,
      inNormBand,
      noiseCheckRequired,
      frictionPaPerM,
    }
  })

  return { paths, issues }
}
