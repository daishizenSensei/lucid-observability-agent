#!/usr/bin/env node
/**
 * Lucid Observability Agent — MCP Server
 *
 * Monitors, diagnoses, and auto-corrects observability issues across
 * platform services using Sentry, OTel traces, and OpenMeter billing data.
 *
 * Config: Set AGENT_CONFIG_PATH to a custom config JSON, or use the
 * default Lucid platform config at ./config/lucid.json.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig } from './config.js'
import { registerSentryTools } from './tools/sentry.js'
import { registerDiagnosisTools } from './tools/diagnosis.js'
import { registerOpenMeterTools } from './tools/openmeter.js'
import { registerConfigHealthTools } from './tools/config-health.js'
import { registerAutoFixTools } from './tools/autofix.js'
import { registerResources } from './resources.js'
import { registerPrompts } from './prompts.js'

async function main() {
  const config = loadConfig()

  const server = new McpServer({
    name: 'lucid-observability-agent',
    version: '2.0.0',
  })

  // Register all tool groups
  registerSentryTools(server, config)
  registerDiagnosisTools(server, config)
  registerOpenMeterTools(server, config)
  registerConfigHealthTools(server, config)
  registerAutoFixTools(server, config)

  // Register resources and prompts
  registerResources(server, config)
  registerPrompts(server, config)

  // Start on stdio transport
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((e) => {
  console.error('Fatal: MCP server failed to start:', e)
  process.exit(1)
})
