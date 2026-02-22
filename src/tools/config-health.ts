/**
 * Configuration health tools — env var auditing and conventions compliance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentConfig } from '../config.js'
import { json } from '../helpers.js'

export function registerConfigHealthTools(server: McpServer, config: AgentConfig) {
  const serviceNames = Object.keys(config.services)
  const serviceEnum = serviceNames.length > 0
    ? z.enum(serviceNames as [string, ...string[]])
    : z.string()

  server.tool(
    'check_config_health',
    'Audit observability configuration for production readiness. Checks Sentry, OTel, metering, PII, and environment settings.',
    { environment: z.enum(['production', 'staging', 'development']).default('production') },
    async ({ environment }) => {
      const checks: Array<{ category: string; service: string; check: string; status: 'pass' | 'warn' | 'fail'; message: string; fix?: string }> = []

      function check(cat: string, svc: string, name: string, status: 'pass' | 'warn' | 'fail', msg: string, fix?: string) {
        checks.push({ category: cat, service: svc, check: name, status, message: msg, fix })
      }

      // Sentry
      const sentryDsn = process.env.SENTRY_DSN
      const sentryAuth = process.env.SENTRY_AUTH_TOKEN
      check('sentry', 'all', 'SENTRY_DSN', sentryDsn ? 'pass' : 'fail', sentryDsn ? 'Configured' : 'Missing — error tracking disabled', 'Set SENTRY_DSN from Sentry project settings')
      check('sentry', 'agent', 'SENTRY_AUTH_TOKEN', sentryAuth ? 'pass' : 'warn', sentryAuth ? 'Configured' : 'Missing — agent cannot query Sentry API', 'Create Sentry internal integration token')

      // OTel
      const otelEnabled = process.env.OTEL_ENABLED
      const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      check('otel', 'all', 'OTEL_ENABLED', otelEnabled === 'true' ? 'pass' : 'warn', otelEnabled === 'true' ? 'Enabled' : 'Disabled — no distributed traces', 'Set OTEL_ENABLED=true')
      if (otelEnabled === 'true') {
        const isLocal = !otelEndpoint || otelEndpoint.includes('localhost')
        check('otel', 'all', 'OTEL_EXPORTER_OTLP_ENDPOINT',
          isLocal && environment === 'production' ? 'fail' : 'pass',
          otelEndpoint ? `Endpoint: ${otelEndpoint}` : 'Using localhost:4318',
          'Set OTEL_EXPORTER_OTLP_ENDPOINT to your collector')
      }

      // PII
      const hashSalt = process.env.OTEL_HASH_SALT
      check('pii', 'all', 'OTEL_HASH_SALT',
        environment === 'production' && !hashSalt ? 'fail' : hashSalt ? 'pass' : 'warn',
        hashSalt ? `Configured (${hashSalt.length} chars)` : 'Missing — identity fields not hashed',
        'Set OTEL_HASH_SALT: openssl rand -hex 32')

      // Metering
      const omEnabled = process.env.OPENMETER_ENABLED
      const omKey = process.env.OPENMETER_API_KEY
      check('openmeter', 'metering', 'OPENMETER_ENABLED', omEnabled === 'true' ? 'pass' : 'warn', omEnabled === 'true' ? 'Enabled' : 'Disabled', 'Set OPENMETER_ENABLED=true')
      if (omEnabled === 'true') {
        check('openmeter', 'metering', 'OPENMETER_API_KEY', omKey ? 'pass' : 'fail', omKey ? 'Configured' : 'Missing — events will fail', 'Set OPENMETER_API_KEY')
      }

      // Database
      check('database', 'metering', 'DATABASE_URL', process.env.DATABASE_URL ? 'pass' : 'warn',
        process.env.DATABASE_URL ? 'Configured' : 'Missing — metering unavailable', 'Set DATABASE_URL')

      // Environment
      const envVar = config.platform.envVar
      const envVal = process.env[envVar]
      check('environment', 'all', envVar, envVal ? 'pass' : 'warn',
        envVal ? `${envVar}=${envVal}` : `${envVar} not set`, `Set ${envVar} explicitly`)

      const passing = checks.filter(c => c.status === 'pass').length
      const warnings = checks.filter(c => c.status === 'warn').length
      const failing = checks.filter(c => c.status === 'fail').length
      const score = Math.round((passing / checks.length) * 100)

      return json({
        summary: { environment, total: checks.length, passing, warnings, failing, score: `${score}%`, productionReady: failing === 0 && score >= 70 },
        checks,
        criticalFixes: checks.filter(c => c.status === 'fail').map(c => ({ check: c.check, service: c.service, fix: c.fix })),
      })
    },
  )

  server.tool(
    'check_conventions',
    'Verify a service uses standard observability conventions: canonical names, required spans, attribute keys.',
    { service: serviceEnum.describe('Service to check') },
    async ({ service }) => {
      const info = config.services[service]
      const issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; fix: string }> = []

      if (!info) {
        issues.push({ severity: 'error', message: `Service "${service}" not found in config`, fix: 'Add it to services in your config JSON' })
        return json({ service, issues })
      }

      if (!config.sentry.projects.includes(info.sentryProject)) {
        issues.push({ severity: 'warning', message: `Sentry project "${info.sentryProject}" not in known projects`, fix: 'Create the Sentry project and add to config' })
      }

      const allSpans = Object.entries(config.conventions.spanNames)
        .filter(([name]) => name.startsWith(service.split('-').pop() || ''))
      if (allSpans.length > 0) {
        issues.push({ severity: 'info', message: `Service should implement spans: ${allSpans.map(([n]) => n).join(', ')}`, fix: 'Use withSpan() for each operation' })
      }

      issues.push({ severity: 'info', message: `Sampling: ${JSON.stringify(config.sampling)}`, fix: 'Override via OTEL_TRACES_SAMPLER_ARG' })

      const piiKeys = Object.entries(config.conventions.attributeKeys).filter(([, v]) => v.pii)
      if (piiKeys.length > 0) {
        issues.push({ severity: 'warning', message: `PII attributes (${piiKeys.map(([k]) => k).join(', ')}) MUST be hashed`, fix: 'Use hashForTelemetry() before setting as span attributes' })
      }

      return json({ service, repo: info.repo, runtime: info.runtime, framework: info.framework, sentryProject: info.sentryProject, issues })
    },
  )
}
