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
    version: '2.1.0',
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

  // Start on stdio transport (always — this is the MCP transport)
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Optional: Webhook server for Sentry alerts
  if (config.webhook.enabled) {
    const { startWebhookServer } = await import('./webhook.js')
    const httpServer = await startWebhookServer(config)
    process.on('SIGTERM', () => httpServer.close())
    process.on('SIGINT', () => httpServer.close())
  }

  // Optional: Periodic health checks
  if (config.periodicChecks.enabled) {
    const { startScheduler } = await import('./scheduler.js')
    const scheduler = startScheduler(config)
    process.on('SIGTERM', () => scheduler.stop())
    process.on('SIGINT', () => scheduler.stop())
  }
}

main().catch((e) => {
  console.error('Fatal: MCP server failed to start:', e)
  process.exit(1)
})
