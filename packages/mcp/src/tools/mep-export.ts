import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  buildDuctSpecification,
  ductsToDxf,
  planSystemMarkings,
  specificationToCsv,
} from '@pascal-app/core'
import type { AnyNode, AnyNodeId } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../operations'

export const mepSpecificationOutput = {
  specification: z.record(z.string(), z.unknown()),
  systems: z.array(z.record(z.string(), z.unknown())),
  totals: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
  csv: z.string(),
}

export const mepDxfInput = {
  labelHeightM: z.number().optional(),
  drawFittings: z.boolean().optional(),
  drawTerminals: z.boolean().optional(),
}

export const mepDxfOutput = {
  dxf: z.string(),
  fileName: z.string(),
  entityCount: z.number(),
  layers: z.array(z.string()),
}

/**
 * MEP export tools (Этап 6): ведомость материалов по ГОСТ-номенклатуре
 * (CSV-ready) и план вентиляции в ASCII DXF с маркировкой П/В/Р по
 * ГОСТ 21.602. Оба — чистые функции `@pascal-app/core`, только читают сцену.
 */
export function registerMepExportTools(server: McpServer, bridge: SceneOperations): void {
  server.registerTool(
    'mep_specification',
    {
      title: 'MEP specification',
      description:
        'Build the ventilation bill-of-materials (ведомость материалов) for the scene: duct runs by ГОСТ Р 70349 size and system (П/В/Р), standard-length breakdown, fittings, terminals, supports, wall sleeves. Returns the structured specification plus a CSV-ready string.',
      inputSchema: {},
      outputSchema: mepSpecificationOutput,
    },
    async () => {
      const nodes = bridge.getNodes() as Readonly<Record<AnyNodeId, AnyNode>>
      const specification = buildDuctSpecification(nodes, {
        markings: planSystemMarkings(nodes),
      })
      const payload = {
        specification,
        systems: specification.systems,
        totals: specification.totals,
        warnings: specification.warnings,
        csv: specificationToCsv(specification),
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )

  server.registerTool(
    'mep_dxf',
    {
      title: 'MEP plan DXF',
      description:
        'Export the ventilation floor plan as ASCII DXF: duct runs on system layers (П supply / В exhaust / Р return), fittings drawn by type (elbow arcs, offset утка S-polyline, tee/cross lines, reducers), wall sleeves and fire dampers at penetrations, П1/В1/Р1 marking labels and a system legend per ГОСТ 21.602.',
      inputSchema: mepDxfInput,
      outputSchema: mepDxfOutput,
    },
    async (input) => {
      const nodes = bridge.getNodes() as Readonly<Record<AnyNodeId, AnyNode>>
      const walls = Object.values(nodes).filter((node) => node?.type === 'wall')
      const dxf = ductsToDxf(nodes, {
        labelHeightM: input?.labelHeightM,
        drawFittings: input?.drawFittings,
        drawTerminals: input?.drawTerminals,
        markings: planSystemMarkings(nodes),
        walls,
      })
      const date = new Date().toISOString().split('T')[0]
      const payload = {
        dxf,
        fileName: `ventilation_plan_${date}.dxf`,
        entityCount:
          (dxf.match(/\n0\nLINE\n/g) ?? []).length +
          (dxf.match(/\n0\nCIRCLE\n/g) ?? []).length +
          (dxf.match(/\n0\nARC\n/g) ?? []).length +
          (dxf.match(/\n0\nTEXT\n/g) ?? []).length,
        layers: [
          'MEP_SUPPLY',
          'MEP_EXHAUST',
          'MEP_RETURN',
          'MEP_FITTING',
          'MEP_TERMINAL',
          'MEP_SLEEVE',
          'MEP_FIRE_DAMPER',
        ],
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}
