#!/usr/bin/env node
/**
 * Lucid Observability Service — Autonomous Monitoring
 *
 * Always-on service that runs independently from the MCP server:
 * - Sentry webhook receiver (auto-triage + auto-resolve)
 * - Periodic health checks (outbox, error spikes, dead letters)
 *
 * Deploy this to Railway/Docker. The MCP server (server.ts) runs
 * separately in Claude Code via stdio.
 */

import { loadConfig } from './config.js'
import { startWebhookServer } from './webhook.js'
import { startScheduler } from './scheduler.js'

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} [service] ${msg}\n`)
}

async function main() {
  const config = loadConfig()

  log('Lucid Observability Service v2.1.0 starting...')

  // Start webhook server
  if (config.webhook.enabled) {
    const httpServer = await startWebhookServer(config)
    process.on('SIGTERM', () => { httpServer.close(); log('Webhook server stopped') })
    process.on('SIGINT', () => { httpServer.close(); log('Webhook server stopped') })
  } else {
    log('Webhook server disabled — set webhook.enabled=true in config')
  }

  // Start periodic health checks
  if (config.periodicChecks.enabled) {
    const scheduler = startScheduler(config)
    process.on('SIGTERM', () => { scheduler.stop() })
    process.on('SIGINT', () => { scheduler.stop() })
  } else {
    log('Periodic checks disabled — set periodicChecks.enabled=true in config')
  }

  if (!config.webhook.enabled && !config.periodicChecks.enabled) {
    log('ERROR: Neither webhook nor periodicChecks enabled. Nothing to do.')
    process.exit(1)
  }

  log('Service running. Press Ctrl+C to stop.')
}

main().catch((e) => {
  console.error('Fatal: Service failed to start:', e)
  process.exit(1)
})
