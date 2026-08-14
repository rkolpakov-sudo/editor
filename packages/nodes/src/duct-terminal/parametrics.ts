import type { ParametricDescriptor } from '@pascal-app/core'
import type { DuctTerminalNode } from './schema'

/**
 * Нормативный mount по типу воздухораспределителя (СП 60/ГОСТ 21.602):
 * приточный диффузор — в потолок (ceiling), вытяжная решётка — на стену
 * (wall), напольная приточная решётка — на пол (floor). Применяется как
 * дефолт при смене типа; пользователь может переопределить вручную.
 */
const NORM_MOUNT_BY_TYPE: Record<DuctTerminalNode['terminalType'], DuctTerminalNode['mount']> = {
  'supply-register': 'floor',
  diffuser: 'ceiling',
  'return-grille': 'wall',
}

export const ductTerminalParametrics: ParametricDescriptor<DuctTerminalNode> = {
  derive: (next, patch) => {
    if ('terminalType' in patch) {
      return { mount: NORM_MOUNT_BY_TYPE[next.terminalType] }
    }
    return {}
  },
  groups: [
    {
      label: 'Terminal',
      fields: [
        {
          key: 'terminalType',
          kind: 'enum',
          options: ['supply-register', 'diffuser', 'return-grille'],
        },
        {
          key: 'mount',
          kind: 'enum',
          options: ['floor', 'ceiling', 'wall'],
          display: 'segmented',
        },
      ],
    },
    {
      label: 'Face',
      fields: [
        { key: 'width', kind: 'number', unit: 'm', min: 0.1, max: 1.5, step: 0.05 },
        { key: 'depth', kind: 'number', unit: 'm', min: 0.05, max: 1.5, step: 0.05 },
      ],
    },
    {
      label: 'Collar',
      fields: [
        {
          key: 'collarShape',
          kind: 'enum',
          options: ['round', 'rect', 'oval'],
          display: 'segmented',
        },
        {
          key: 'collarDiameter',
          kind: 'number',
          unit: 'in',
          min: 4,
          max: 20,
          step: 1,
          visibleIf: (n) => n.collarShape === 'round',
        },
        {
          key: 'collarWidth',
          kind: 'number',
          unit: 'in',
          min: 4,
          max: 20,
          step: 1,
          visibleIf: (n) => n.collarShape !== 'round',
        },
        {
          key: 'collarHeight',
          kind: 'number',
          unit: 'in',
          min: 3,
          max: 20,
          step: 1,
          visibleIf: (n) => n.collarShape !== 'round',
        },
      ],
    },
    {
      label: 'Placement',
      fields: [{ key: 'position', kind: 'vec3' }],
    },
  ],
}
