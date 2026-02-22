/**
 * MCP Prompts — guided workflows for common operations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentConfig } from './config.js'

export function registerPrompts(server: McpServer, config: AgentConfig) {
  const serviceList = Object.keys(config.services).join(', ')

  server.prompt(
    'triage-issue',
    'Guided workflow to triage a Sentry issue: fetch details, diagnose, check cross-service impact, suggest fixes.',
    { issueId: z.string().describe('Sentry issue ID') },
    async ({ issueId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Triage Sentry issue ${issueId}:

1. Use \`sentry_get_issue\` for full details including stack trace and cross-link tags.
2. Use \`diagnose_issue\` for root cause analysis.
3. If the issue has a trace_id, use \`cross_correlate\` to check for cascade across services.
4. Use \`sentry_get_issue_events\` for temporal pattern detection.
5. Use \`generate_runbook\` for the diagnosed category.
6. If severity is critical/high, use \`suggest_alert_rules\` to ensure coverage.

Summarize: root cause, severity, blast radius, recommended action, long-term fix.`,
        },
      }],
    }),
  )

  server.prompt(
    'production-readiness',
    'Full production readiness audit: config, conventions, metering, alerts.',
    {},
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Production readiness audit:

1. \`check_config_health\` with environment="production"
2. For each service [${serviceList}]: \`check_conventions\`
3. \`openmeter_outbox_health\` (24h)
4. \`openmeter_usage_anomaly\` for billing health
5. For each Sentry project: \`suggest_alert_rules\`
6. \`sentry_list_issues\` with query="is:unresolved level:fatal"

Produce a scorecard: overall score (0-100), critical blockers, warnings, recommendations.`,
        },
      }],
    }),
  )

  server.prompt(
    'incident-response',
    'Guided incident response workflow.',
    {
      service: z.string().optional().describe('Affected service'),
      symptom: z.string().optional().describe('Symptom description'),
    },
    async ({ service, symptom }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Incident response for ${service || 'unknown service'}: ${symptom || 'errors detected'}

## Phase 1: Assess
1. \`sentry_list_issues\` for ${service ? `${service}` : 'all projects'}, sorted by priority
2. \`sentry_get_issue\` for top 3 issues
3. \`cross_correlate\` with trace_ids to assess blast radius

## Phase 2: Diagnose
4. \`diagnose_issue\` for primary issue
5. \`generate_runbook\` for the category
6. \`openmeter_outbox_health\` to check metering

## Phase 3: Mitigate
7. Follow runbook mitigation steps
8. If critical: recommend rollback
9. \`sentry_resolve_issue\` when fixed

## Phase 4: Document
Timeline, root cause, services affected, user impact, actions taken, follow-ups.`,
        },
      }],
    }),
  )
}
