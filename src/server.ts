#!/usr/bin/env node
/**
 * Lucid Observability Agent — MCP Server
 *
 * Passive tool provider for Claude Code / Claude Desktop.
 * Exposes 16 tools, 3 resources, 3 prompts over stdio transport.
 *
 * For the autonomous monitoring service (webhooks + periodic checks),
 * see service.ts.
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
    version: '2.1.0',
  })

  registerSentryTools(server, config)
  registerDiagnosisTools(server, config)
  registerOpenMeterTools(server, config)
  registerConfigHealthTools(server, config)
  registerAutoFixTools(server, config)
  registerResources(server, config)
  registerPrompts(server, config)

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((e) => {
  console.error('Fatal: MCP server failed to start:', e)
  process.exit(1)
})
