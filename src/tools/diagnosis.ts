/**
 * Diagnosis tools — root cause analysis and cross-service correlation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentConfig } from '../config.js'
import { sentryFetch, extractStacktrace, extractBreadcrumbs, json, err } from '../helpers.js'

export function registerDiagnosisTools(server: McpServer, config: AgentConfig) {
  server.tool(
    'diagnose_issue',
    'Deep root-cause analysis of a Sentry issue. Examines stack trace, error patterns, frequency, and platform-specific knowledge to produce actionable diagnosis.',
    { issueId: z.string().describe('Sentry issue ID to diagnose') },
    async ({ issueId }) => {
      try {
        const [issue, latestEvent] = await Promise.all([
          sentryFetch(config, `/issues/${issueId}/`) as Promise<Record<string, unknown>>,
          sentryFetch(config, `/issues/${issueId}/events/latest/`) as Promise<Record<string, unknown>>,
        ])

        const stacktrace = extractStacktrace(latestEvent)
        const breadcrumbs = extractBreadcrumbs(latestEvent)
        const tags = (latestEvent.tags || []) as Array<{ key: string; value: string }>

        const diagnosis = buildDiagnosis(config, {
          title: String(issue.title || ''),
          culprit: String(issue.culprit || ''),
          count: Number(issue.count || 0),
          userCount: Number(issue.userCount || 0),
          level: String(issue.level || 'error'),
          stacktrace, breadcrumbs, tags,
          firstSeen: String(issue.firstSeen || ''),
          lastSeen: String(issue.lastSeen || ''),
          project: String((issue.project as Record<string, unknown>)?.slug || 'unknown'),
        })

        return json(diagnosis)
      } catch (e) { return err(e) }
    },
  )

  server.tool(
    'cross_correlate',
    'Correlate errors across services using trace_id or run_id. Finds related Sentry issues across all projects to build a cross-service error timeline.',
    {
      traceId: z.string().optional().describe('OTel trace ID (32-char hex)'),
      runId: z.string().optional().describe('Run ID (UUID)'),
    },
    async ({ traceId, runId }) => {
      if (!traceId && !runId) return err('Provide at least one of traceId or runId')

      try {
        const projects = config.sentry.projects
        const queries: Array<{ project: string; query: string }> = []

        for (const project of projects) {
          if (traceId) queries.push({ project, query: `trace_id:${traceId}` })
          if (runId) queries.push({ project, query: `run_id:${runId}` })
        }

        const results: Array<{ project: string; query: string; issues: unknown[] }> = []
        for (let i = 0; i < queries.length; i += 6) {
          const batch = queries.slice(i, i + 6)
          const batchResults = await Promise.all(
            batch.map(async ({ project, query }) => {
              try {
                const issues = await sentryFetch(config,
                  `/issues/?project=${project}&query=${encodeURIComponent(query)}&limit=10`
                ) as Array<Record<string, unknown>>
                return { project, query, issues }
              } catch { return { project, query, issues: [] } }
            })
          )
          results.push(...batchResults)
        }

        const seenIds = new Set<string>()
        const allIssues: Array<Record<string, unknown>> = []
        for (const r of results) {
          for (const issue of r.issues as Array<Record<string, unknown>>) {
            const id = String(issue.id)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allIssues.push({
                id: issue.id, shortId: issue.shortId, title: issue.title,
                culprit: issue.culprit, level: issue.level, count: issue.count,
                project: (issue.project as Record<string, unknown>)?.slug,
                firstSeen: issue.firstSeen, lastSeen: issue.lastSeen,
              })
            }
          }
        }

        allIssues.sort((a, b) => new Date(b.lastSeen as string).getTime() - new Date(a.lastSeen as string).getTime())
        const services = [...new Set(allIssues.map(i => i.project).filter(Boolean))]

        return json({
          correlation: { traceId: traceId || null, runId: runId || null },
          totalIssues: allIssues.length, affectedServices: services,
          cascadeDetected: services.length > 1,
          timeline: allIssues,
          analysis: services.length > 1
            ? `Cross-service error cascade detected across ${services.join(', ')}. Investigate the oldest issue first.`
            : services.length === 1
              ? `Errors isolated to ${services[0]}. No cross-service cascade.`
              : 'No errors found for this trace/run across any project.',
        })
      } catch (e) { return err(e) }
    },
  )
}

/* ─── Diagnosis Engine ────────────────────────────────── */

export interface DiagnosisInput {
  title: string; culprit: string; count: number; userCount: number
  level: string; stacktrace: string[]
  breadcrumbs: Array<{ timestamp: string; category: string; message: string }>
  tags: Array<{ key: string; value: string }>
  firstSeen: string; lastSeen: string; project: string
}

export function buildDiagnosis(config: AgentConfig, input: DiagnosisInput) {
  const title = input.title.toLowerCase()
  const culprit = input.culprit.toLowerCase()
  const stack = input.stacktrace.join('\n').toLowerCase()

  let category = 'application_error'
  let rootCause = `Application error in ${input.culprit || 'unknown location'}`
  const suggestions: Array<{ action: string; description: string; confidence: 'high' | 'medium' | 'low'; command?: string }> = []
  const relatedPatterns: string[] = []

  // Try config-defined patterns first
  for (const pattern of config.diagnosisPatterns) {
    if (pattern.keywords.some(kw => title.includes(kw) || culprit.includes(kw) || stack.includes(kw))) {
      category = pattern.category
      rootCause = pattern.rootCause
      suggestions.push(...pattern.suggestions)
      relatedPatterns.push(...pattern.relatedPatterns)
      break
    }
  }

  // Fall back to built-in patterns if no config match
  if (category === 'application_error') {
    if (title.includes('fetch failed') || title.includes('econnrefused') || title.includes('enotfound') || title.includes('econnreset') || title.includes('network')) {
      category = 'network_error'
      rootCause = 'External service unreachable or network issue'
      suggestions.push(
        { action: 'check_provider', description: 'Check upstream provider health', confidence: 'high' },
        { action: 'add_retry', description: 'Add retry with exponential backoff', confidence: 'medium' },
        { action: 'add_circuit_breaker', description: 'Implement circuit breaker', confidence: 'medium' },
      )
      relatedPatterns.push('Provider outage', 'DNS failure', 'Connection pool exhaustion')
    } else if (title.includes('timeout') || title.includes('aborterror') || title.includes('abort') || title.includes('deadline')) {
      category = 'timeout'
      rootCause = 'Operation exceeded time limit'
      suggestions.push(
        { action: 'use_streaming', description: 'Switch to streaming for long operations', confidence: 'high' },
        { action: 'check_pool', description: 'Check connection pool utilization', confidence: 'medium' },
        { action: 'review_timeout', description: 'Review timeout values', confidence: 'medium' },
      )
      relatedPatterns.push('Slow response', 'Pool exhaustion', 'Resource contention')
    } else if (title.includes('unauthorized') || title.includes('401') || title.includes('403') || title.includes('forbidden') || title.includes('auth')) {
      category = 'auth_error'
      rootCause = 'Authentication or authorization failure'
      suggestions.push(
        { action: 'rotate_keys', description: 'Check if API keys have expired', confidence: 'high' },
        { action: 'check_config', description: 'Verify auth configuration', confidence: 'high' },
      )
      relatedPatterns.push('Key rotation', 'Tenant misconfiguration', 'CORS')
    } else if (title.includes('rate') || title.includes('429') || title.includes('quota') || title.includes('too many')) {
      category = 'rate_limit'
      rootCause = 'Rate limit or quota exceeded'
      suggestions.push(
        { action: 'check_quotas', description: 'Review quota/rate limit settings', confidence: 'high' },
        { action: 'add_queuing', description: 'Add request queuing', confidence: 'medium' },
      )
      relatedPatterns.push('Provider rate limit', 'Quota exceeded', 'Burst traffic')
    } else if (title.includes('database') || title.includes('postgres') || title.includes('unique constraint') || title.includes('deadlock') || title.includes('connection')) {
      category = 'database_error'
      rootCause = 'Database connectivity or query issue'
      suggestions.push(
        { action: 'check_db', description: 'Verify database connectivity', confidence: 'high' },
        { action: 'check_pool', description: 'Review connection pool config', confidence: 'medium' },
        { action: 'check_migrations', description: 'Ensure migrations are applied', confidence: 'medium' },
      )
      relatedPatterns.push('Pool exhaustion', 'Missing migration', 'Lock contention')
    } else if (title.includes('validation') || title.includes('zod') || title.includes('parse') || title.includes('schema')) {
      category = 'validation_error'
      rootCause = 'Request payload failed schema validation'
      suggestions.push(
        { action: 'check_schema', description: 'Review API schema', confidence: 'high' },
        { action: 'add_error_detail', description: 'Return validation errors in API response', confidence: 'high' },
      )
      relatedPatterns.push('Schema mismatch', 'Client update needed', 'Missing field')
    } else if (title.includes('heap') || title.includes('out of memory') || title.includes('oom')) {
      category = 'memory_leak'
      rootCause = 'Memory limit exceeded'
      suggestions.push(
        { action: 'check_heap', description: 'Take heap snapshot', confidence: 'high' },
        { action: 'check_streams', description: 'Verify streams are closed', confidence: 'medium' },
      )
      relatedPatterns.push('Unbounded cache', 'Event listener leak', 'Large payload')
    } else {
      suggestions.push(
        { action: 'investigate', description: 'Examine the full stack trace', confidence: 'high' },
        { action: 'add_context', description: 'Add breadcrumbs around the error', confidence: 'medium' },
      )
    }
  }

  // Check known bugs
  for (const bug of config.knownBugs) {
    if (bug.keywords.some(kw => title.includes(kw) || stack.includes(kw))) {
      suggestions.unshift({ action: 'known_bug', description: `Known bug: ${bug.title} — ${bug.fix}`, confidence: 'high' })
    }
  }

  // Severity
  const recentActivity = (Date.now() - new Date(input.lastSeen).getTime()) < 1000 * 60 * 60
  let severity: 'critical' | 'high' | 'medium' | 'low'
  if (input.level === 'fatal' || input.count > 1000 || (input.count > 100 && recentActivity)) severity = 'critical'
  else if (input.level === 'error' && (input.count > 100 || input.userCount > 10)) severity = 'high'
  else if (input.level === 'error' && input.count > 10) severity = 'medium'
  else severity = 'low'

  // Service context
  const serviceTag = input.tags.find(t => t.key === 'service')?.value
  const envTag = input.tags.find(t => t.key === 'environment')?.value
  const service = serviceTag || input.project || 'unknown'
  const serviceInfo = config.services[service]
  const ageDays = (Date.now() - new Date(input.firstSeen).getTime()) / (1000 * 60 * 60 * 24)

  return {
    category, severity,
    summary: `[${severity.toUpperCase()}] ${category}: ${input.title}`,
    rootCause,
    context: {
      service, repo: serviceInfo?.repo || 'unknown', runtime: serviceInfo?.runtime || 'unknown',
      environment: envTag || 'unknown', eventCount: input.count, userCount: input.userCount,
      age: `${ageDays.toFixed(1)} days`, lastActive: recentActivity ? 'within last hour' : input.lastSeen,
    },
    suggestions, relatedPatterns,
    nextSteps: [
      'Run: cross_correlate with trace_id to check cascade',
      `Run: generate_runbook with category="${category}"`,
      severity === 'critical' || severity === 'high' ? 'URGENT: Follow runbook mitigation steps' : 'Monitor frequency trend',
    ],
    breadcrumbs: input.breadcrumbs.length > 0 ? input.breadcrumbs : undefined,
  }
}
