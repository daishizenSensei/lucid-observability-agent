/**
 * MCP Resources — reference data for conventions, service topology, and sampling.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentConfig } from './config.js'

export function registerResources(server: McpServer, config: AgentConfig) {
  const prefix = config.platform.name

  server.resource(
    'conventions',
    `${prefix}://conventions`,
    { mimeType: 'application/json', description: 'Observability conventions: service names, span names, attribute keys, and rules' },
    async () => ({
      contents: [{
        uri: `${prefix}://conventions`,
        mimeType: 'application/json',
        text: JSON.stringify({
          services: config.services,
          spanNames: config.conventions.spanNames,
          attributeKeys: config.conventions.attributeKeys,
          rules: config.conventions.rules,
        }, null, 2),
      }],
    }),
  )

  server.resource(
    'services',
    `${prefix}://services`,
    { mimeType: 'application/json', description: 'Service topology and dependencies' },
    async () => ({
      contents: [{
        uri: `${prefix}://services`,
        mimeType: 'application/json',
        text: JSON.stringify({
          services: config.services,
          dependencies: config.dependencies,
          traceFlow: config.traceFlow,
        }, null, 2),
      }],
    }),
  )

  server.resource(
    'sampling',
    `${prefix}://sampling`,
    { mimeType: 'application/json', description: 'Sampling strategy reference' },
    async () => ({
      contents: [{
        uri: `${prefix}://sampling`,
        mimeType: 'application/json',
        text: JSON.stringify({
          headSampling: config.sampling,
          tailSampling: {
            description: 'Configure at collector level (Grafana Tempo, Honeycomb)',
            rules: ['Keep 100% of traces containing error spans', 'Keep 100% of traces with latency > p99', 'Keep 100% of traces with span.status = ERROR'],
          },
          override: 'Set OTEL_TRACES_SAMPLER_ARG env var to override head sampling ratio',
        }, null, 2),
      }],
    }),
  )
}
