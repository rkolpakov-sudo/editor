import { describe, expect, test } from 'bun:test'
import {
  ductSegment,
  ductTerminal,
  hvacUnit,
  registerDuctNetworkStubs,
  sceneOf,
  twoBranchSupplyScene,
} from './duct-network-stubs'
import { computeNetworkFlows, networkFlowsForSegment } from './network-flows'

registerDuctNetworkStubs()

function supplyNetwork() {
  return {
    equipment: hvacUnit([0, 0, 0]),
    segment: ductSegment(
      [
        [0, 0, 0],
        [3, 0, 0],
      ],
      'supply',
    ),
    terminal: ductTerminal([3, 0, 0], 'diffuser'),
  }
}

function exhaustNetwork() {
  return {
    segment: ductSegment(
      [
        [10, 0, 0],
        [13, 0, 0],
      ],
      'exhaust',
    ),
    terminal: ductTerminal([13, 0, 0], 'return-grille'),
  }
}

describe('computeNetworkFlows — пропагация расходов к магистрали', () => {
  test('магистраль несёт сумму ответвлений, каждый участок — свою подветку', () => {
    const { nodes, seg1, seg2, seg3, branch1, branch2, term1, term2, equipment } =
      twoBranchSupplyScene()
    const flows = computeNetworkFlows(nodes, {
      terminalFlows: { [term1.id]: 30, [term2.id]: 60 },
    })

    expect(flows).toHaveLength(1)
    const network = flows[0]!
    expect(network.systems).toEqual(['supply'])
    expect(network.connectedToEquipment).toBe(true)
    expect(network.rootedAtEquipment).toBe(true)
    expect(network.rootId).toBe(equipment.id)
    expect(network.totalFlowM3h).toBe(90)
    expect(network.segmentFlows[seg1.id]).toBeCloseTo(90, 9)
    expect(network.segmentFlows[seg2.id]).toBeCloseTo(60, 9)
    expect(network.segmentFlows[branch1.id]).toBeCloseTo(30, 9)
    expect(network.segmentFlows[branch2.id]).toBeCloseTo(60, 9)
    expect(network.segmentFlows[seg3.id]).toBeCloseTo(0, 9)

    expect(network.terminals).toHaveLength(2)
    const t1 = network.terminals.find((t) => t.terminalId === term1.id)!
    const t2 = network.terminals.find((t) => t.terminalId === term2.id)!
    expect(t1.flowM3h).toBe(30)
    expect(t1.assigned).toBe(true)
    expect(t2.flowM3h).toBe(60)
    expect(t2.assigned).toBe(true)
  })

  test('терминал без назначенного расхода несёт 0 и помечен как неназначенный', () => {
    const { nodes, term1, term2, seg1 } = twoBranchSupplyScene()
    const flows = computeNetworkFlows(nodes, { terminalFlows: { [term1.id]: 30 } })
    const network = flows[0]!
    const unassigned = network.terminals.find((t) => t.terminalId === term2.id)!
    expect(unassigned.flowM3h).toBe(0)
    expect(unassigned.assigned).toBe(false)
    expect(network.segmentFlows[seg1.id]).toBeCloseTo(30, 9)
  })

  test('без оборудования расходы считаются от корня-магистрали (флаг false)', () => {
    const { nodes, equipment, seg1, term1 } = twoBranchSupplyScene()
    delete nodes[equipment.id]
    const flows = computeNetworkFlows(nodes, { terminalFlows: { [term1.id]: 45 } })
    const network = flows[0]!
    expect(network.connectedToEquipment).toBe(false)
    expect(network.rootedAtEquipment).toBe(false)
    expect(network.totalFlowM3h).toBe(45)
    // Назначенный расход не теряется: он лежит на каком-то участке сети.
    expect(Object.values(network.segmentFlows).some((flow) => flow === 45)).toBe(true)
    void seg1
  })

  test('независимые сети П и В считаются раздельно', () => {
    const supply = supplyNetwork()
    const exhaust = exhaustNetwork()
    const nodes = sceneOf(
      supply.equipment,
      supply.segment,
      supply.terminal,
      exhaust.segment,
      exhaust.terminal,
    )
    const flows = computeNetworkFlows(nodes, {
      terminalFlows: {
        [supply.terminal.id]: 100,
        [exhaust.terminal.id]: 50,
      },
    })
    expect(flows).toHaveLength(2)
    const supplyFlow = flows.find((flow) => flow.systems.includes('supply'))!
    const exhaustFlow = flows.find((flow) => flow.systems.includes('exhaust'))!
    expect(supplyFlow.connectedToEquipment).toBe(true)
    expect(exhaustFlow.connectedToEquipment).toBe(false)
    expect(supplyFlow.totalFlowM3h).toBe(100)
    expect(exhaustFlow.totalFlowM3h).toBe(50)
    expect(supplyFlow.segmentFlows[supply.segment.id]).toBe(100)
    expect(exhaustFlow.segmentFlows[exhaust.segment.id]).toBe(50)
  })

  test('networkFlowsForSegment находит сеть участка', () => {
    const { nodes, seg2 } = twoBranchSupplyScene()
    const flows = computeNetworkFlows(nodes, {})
    const network = networkFlowsForSegment(seg2.id, flows)
    expect(network).not.toBeNull()
    expect(network!.segmentFlows[seg2.id]).toBe(0)
  })
})
