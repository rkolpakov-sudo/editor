import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DuctSegmentNode } from '@pascal-app/core/schema'
import { SceneBridge } from '../bridge/scene-bridge'
import { registerMepExportTools } from './mep-export'

describe('mep_specification', () => {
  let client: Client
  let bridge: SceneBridge

  beforeEach(async () => {
    bridge = new SceneBridge()
    bridge.setScene({}, [])
    bridge.loadDefault()
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerMepExportTools(server, bridge)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })

  test('returns an empty specification for an empty scene', async () => {
    const result = await client.callTool({ name: 'mep_specification', arguments: {} })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    expect(parsed.totals.lengthM).toBe(0)
    expect(parsed.systems).toHaveLength(0)
    expect(typeof parsed.csv).toBe('string')
  })

  test('reports duct length and a CSV row for a scene with one segment', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const segment = DuctSegmentNode.parse({
      path: [
        [0, 2.6, 0],
        [2.5, 2.6, 0],
      ],
      system: 'supply',
      diameter: 160,
    })
    bridge.createNode(segment, level.id)

    const result = await client.callTool({ name: 'mep_specification', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    expect(parsed.totals.lengthM).toBeCloseTo(2.5, 5)
    expect(parsed.totals.fittings).toBe(0)
    expect(parsed.systems[0]!.system).toBe('supply')
    expect(parsed.csv).toContain('Воздуховод круглый Ø160')
  })
})

describe('mep_dxf', () => {
  let client: Client
  let bridge: SceneBridge

  beforeEach(async () => {
    bridge = new SceneBridge()
    bridge.setScene({}, [])
    bridge.loadDefault()
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerMepExportTools(server, bridge)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })

  test('exports an ASCII DXF plan with system layers', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const segment = DuctSegmentNode.parse({
      path: [
        [0, 2.6, 0],
        [2.5, 2.6, 0],
      ],
      system: 'supply',
    })
    bridge.createNode(segment, level.id)

    const result = await client.callTool({ name: 'mep_dxf', arguments: {} })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    expect(parsed.dxf).toContain('SECTION')
    expect(parsed.dxf.trimEnd().endsWith('EOF')).toBe(true)
    expect(parsed.dxf).toContain('MEP_SUPPLY')
    expect(parsed.layers).toContain('MEP_EXHAUST')
    expect(parsed.fileName).toMatch(/ventilation_plan_\d{4}-\d{2}-\d{2}\.dxf/)
    expect(parsed.entityCount).toBeGreaterThanOrEqual(1)
  })
})
