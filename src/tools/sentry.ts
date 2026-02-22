/**
 * Sentry tools — 6 tools for querying and managing Sentry issues.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentConfig } from '../config.js'
import { sentryFetch, extractStacktrace, extractBreadcrumbs, detectTemporalPattern, json, err } from '../helpers.js'

export function registerSentryTools(server: McpServer, config: AgentConfig) {
  const projects = config.sentry.projects
  const projectEnum = projects.length > 0
    ? z.enum(projects as [string, ...string[]])
    : z.string().describe('Sentry project slug')

  server.tool(
    'sentry_list_issues',
    'List recent Sentry issues for a project. Supports Sentry search syntax.',
    {
      project: projectEnum.describe('Sentry project slug'),
      query: z.string().default('is:unresolved').describe('Sentry search query'),
      limit: z.number().min(1).max(100).default(25),
      sort: z.enum(['date', 'new', 'freq', 'priority']).default('priority'),
    },
    async ({ project, query, limit, sort }) => {
      try {
        const issues = await sentryFetch(config,
          `/issues/?project=${project}&query=${encodeURIComponent(query)}&limit=${limit}&sort=${sort}`
        )
        if (!Array.isArray(issues)) return json(issues)

        const summary = issues.map((i: Record<string, unknown>) => ({
          id: i.id, shortId: i.shortId, title: i.title, culprit: i.culprit,
          level: i.level, count: i.count, userCount: i.userCount,
          firstSeen: i.firstSeen, lastSeen: i.lastSeen,
          status: i.status, isRegression: i.isRegression, priority: i.priority,
          assignedTo: (i.assignedTo as Record<string, unknown>)?.name || null,
        }))

        return json({ total: summary.length, issues: summary })
      } catch (e) { return err(e) }
    },
  )

  server.tool(
    'sentry_get_issue',
    'Get full Sentry issue detail with latest event stack trace, tags, contexts, and cross-links.',
    { issueId: z.string().describe('Sentry issue ID') },
    async ({ issueId }) => {
      try {
        const [issue, latestEvent] = await Promise.all([
          sentryFetch(config, `/issues/${issueId}/`) as Promise<Record<string, unknown>>,
          sentryFetch(config, `/issues/${issueId}/events/latest/`) as Promise<Record<string, unknown>>,
        ])

        const stacktrace = extractStacktrace(latestEvent)
        const tags = (latestEvent.tags || []) as Array<{ key: string; value: string }>
        const contexts = (latestEvent.contexts || {}) as Record<string, unknown>
        const breadcrumbs = extractBreadcrumbs(latestEvent)

        return json({
          issue: {
            id: issue.id, shortId: issue.shortId, title: issue.title,
            culprit: issue.culprit, level: issue.level,
            count: issue.count, userCount: issue.userCount,
            firstSeen: issue.firstSeen, lastSeen: issue.lastSeen,
            status: issue.status, substatus: issue.substatus,
            isRegression: issue.isRegression, priority: issue.priority,
            project: (issue.project as Record<string, unknown>)?.slug,
          },
          latestEvent: {
            eventId: latestEvent.eventID,
            message: latestEvent.message || latestEvent.title,
            stacktrace, breadcrumbs,
            tags: Object.fromEntries(tags.map(t => [t.key, t.value])),
            otelContext: contexts.otel || null,
            runtime: contexts.runtime || null,
          },
          crossLinks: {
            traceId: tags.find(t => t.key === 'trace_id')?.value || null,
            runId: tags.find(t => t.key === 'run_id')?.value || null,
            service: tags.find(t => t.key === 'service')?.value || null,
            environment: tags.find(t => t.key === 'environment')?.value || null,
          },
        })
      } catch (e) { return err(e) }
    },
  )

  server.tool(
    'sentry_get_issue_events',
    'Get recent events for a Sentry issue. Detects temporal patterns (burst, steady, regression).',
    {
      issueId: z.string().describe('Sentry issue ID'),
      limit: z.number().min(1).max(100).default(25),
    },
    async ({ issueId, limit }) => {
      try {
        const events = await sentryFetch(config,
          `/issues/${issueId}/events/?limit=${limit}`
        ) as Array<Record<string, unknown>>

        const mapped = events.map(e => {
          const tags = (e.tags || []) as Array<{ key: string; value: string }>
          return {
            eventId: e.eventID, timestamp: e.dateCreated,
            message: e.message || e.title,
            traceId: tags.find(t => t.key === 'trace_id')?.value,
            runId: tags.find(t => t.key === 'run_id')?.value,
            service: tags.find(t => t.key === 'service')?.value,
            environment: tags.find(t => t.key === 'environment')?.value,
            release: tags.find(t => t.key === 'release')?.value,
          }
        })

        const pattern = detectTemporalPattern(mapped.map(e => e.timestamp as string))
        const services = [...new Set(mapped.map(e => e.service).filter(Boolean))]
        const environments = [...new Set(mapped.map(e => e.environment).filter(Boolean))]

        return json({ total: mapped.length, pattern, affectedServices: services, affectedEnvironments: environments, events: mapped })
      } catch (e) { return err(e) }
    },
  )

  server.tool(
    'sentry_resolve_issue',
    'Update a Sentry issue status: resolve, ignore, or unresolve.',
    {
      issueId: z.string().describe('Sentry issue ID'),
      action: z.enum(['resolve', 'ignore', 'unresolve']),
      ignoreDuration: z.number().optional().describe('Minutes to ignore (omit = forever)'),
    },
    async ({ issueId, action, ignoreDuration }) => {
      try {
        let body: Record<string, unknown>
        if (action === 'resolve') body = { status: 'resolved' }
        else if (action === 'ignore') body = ignoreDuration ? { status: 'ignored', statusDetails: { ignoreDuration } } : { status: 'ignored' }
        else body = { status: 'unresolved' }

        const result = await sentryFetch(config, `/issues/${issueId}/`, { method: 'PUT', body })
        return json({ success: true, action, issueId, result })
      } catch (e) { return err(e) }
    },
  )

  server.tool(
    'sentry_search_by_trace',
    'Find all Sentry errors linked to a specific OTel trace ID across projects.',
    {
      traceId: z.string().min(16).max(32).describe('OTel trace ID (32-char hex)'),
      project: z.string().optional().describe('Limit to specific project'),
    },
    async ({ traceId, project }) => {
      try {
        const query = `trace_id:${traceId}`
        const projectFilter = project ? `&project=${project}` : ''
        const issues = await sentryFetch(config,
          `/issues/?query=${encodeURIComponent(query)}${projectFilter}&limit=50`
        ) as Array<Record<string, unknown>>

        const results = issues.map((i: Record<string, unknown>) => ({
          id: i.id, shortId: i.shortId, title: i.title,
          culprit: i.culprit, level: i.level, count: i.count,
          project: (i.project as Record<string, unknown>)?.slug,
          firstSeen: i.firstSeen, lastSeen: i.lastSeen,
        }))

        return json({
          traceId, issuesFound: results.length, issues: results,
          hint: results.length === 0
            ? 'No Sentry errors found for this trace. Verify enrichSentryEvent() is called in beforeSend.'
            : null,
        })
      } catch (e) { return err(e) }
    },
  )

  server.tool(
    'sentry_project_stats',
    'Get error rate trends for a Sentry project over a time range.',
    {
      project: projectEnum.describe('Sentry project slug'),
      stat: z.enum(['received', 'rejected', 'blacklisted']).default('received'),
      interval: z.enum(['1h', '1d']).default('1d'),
      period: z.string().default('14d').describe('Lookback period (e.g., "7d", "14d")'),
    },
    async ({ project, stat, interval, period }) => {
      try {
        const data = await sentryFetch(config,
          `/stats_v2/?project=${project}&field=sum(quantity)&category=error&outcome=${stat}&interval=${interval}&statsPeriod=${period}`
        )
        return json({ project, stat, interval, period, data })
      } catch (e) { return err(e) }
    },
  )
}
