import { describe, expect, test } from 'bun:test'
import { ductTerminalParametrics } from './parametrics'
import { DuctTerminalNode } from './schema'

const terminal = (overrides: Partial<DuctTerminalNode>): DuctTerminalNode =>
  DuctTerminalNode.parse({ ...ductTerminalDefaults(), ...overrides })

function ductTerminalDefaults() {
  return DuctTerminalNode.parse({ id: 'duct-terminal_t', position: [0, 0, 0] })
}

describe('ductTerminalParametrics.derive — норм-дефолт mount по типу (fix #3)', () => {
  test('приточный диффузор — в потолок (ceiling)', () => {
    const next = terminal({ terminalType: 'diffuser' })
    const patch = { terminalType: 'diffuser' as const }
    const derived = ductTerminalParametrics.derive?.(next, patch)
    expect(derived).toEqual({ mount: 'ceiling' })
  })

  test('вытяжная решётка — на стену (wall)', () => {
    const next = terminal({ terminalType: 'return-grille' })
    const patch = { terminalType: 'return-grille' as const }
    const derived = ductTerminalParametrics.derive?.(next, patch)
    expect(derived).toEqual({ mount: 'wall' })
  })

  test('напольная приточная решётка — на пол (floor)', () => {
    const next = terminal({ terminalType: 'supply-register' })
    const patch = { terminalType: 'supply-register' as const }
    const derived = ductTerminalParametrics.derive?.(next, patch)
    expect(derived).toEqual({ mount: 'floor' })
  })

  test('другие поля не переписывают mount', () => {
    const next = terminal({ terminalType: 'diffuser', mount: 'wall' })
    const derived = ductTerminalParametrics.derive?.(next, { width: 0.6 })
    expect(derived).toEqual({})
  })
})
