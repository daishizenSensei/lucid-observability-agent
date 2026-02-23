/**
 * Sentry tools -- 6 tools for querying and managing Sentry issues.
 * Converted from Zod+server.tool() to ToolParamDef factory functions.
 */

import type { ToolDefinition } from './types.js';
import type { AgentConfig } from '../types/config.js';
import { sentryFetch } from '../helpers/sentry.js';
import { extractStacktrace, extractBreadcrumbs, detectTemporalPattern } from '../helpers/temporal.js';
import { json, err } from '../helpers/response.js';

interface ToolDeps {
  config: AgentConfig;
}

/* ------------------------------------------------------------------ */
/*  1. sentry_list_issues                                             */
/* ------------------------------------------------------------------ */

export function createSentryListIssuesTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const projects = config.sentry.projects;

  return {
    name: 'sentry_list_issues',
    description:
      'List recent Sentry issues for a project. Supports Sentry search syntax.',
    params: {
      project:
        projects.length > 0
          ? { type: 'enum', values: projects, description: 'Sentry project slug' }
          : { type: 'string', description: 'Sentry project slug' },
      query: {
        type: 'string',
        default: 'is:unresolved',
        required: false,
        description: 'Sentry search query',
      },
      limit: { type: 'number', min: 1, max: 100, default: 25, required: false },
      sort: {
        type: 'enum',
        values: ['date', 'new', 'freq', 'priority'],
        default: 'priority',
        required: false,
      },
    },
    execute: async ({
      project,
      query = 'is:unresolved',
      limit = 25,
      sort = 'priority',
    }) => {
      try {
        const issues = await sentryFetch(
          config,
          `/issues/?project=${project}&query=${encodeURIComponent(query)}&limit=${limit}&sort=${sort}`,
        );
        if (!Array.isArray(issues)) return json(issues);

        const summary = issues.map((i: Record<string, unknown>) => ({
          id: i.id,
          shortId: i.shortId,
          title: i.title,
          culprit: i.culprit,
          level: i.level,
          count: i.count,
          userCount: i.userCount,
          firstSeen: i.firstSeen,
          lastSeen: i.lastSeen,
          status: i.status,
          isRegression: i.isRegression,
          priority: i.priority,
          assignedTo:
            (i.assignedTo as Record<string, unknown>)?.name || null,
        }));

        return json({ total: summary.length, issues: summary });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  2. sentry_get_issue                                               */
/* ------------------------------------------------------------------ */

export function createSentryGetIssueTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_get_issue',
    description:
      'Get full Sentry issue detail with latest event stack trace, tags, contexts, and cross-links.',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID' },
    },
    execute: async ({ issueId }) => {
      try {
        const [issue, latestEvent] = await Promise.all([
          sentryFetch(config, `/issues/${issueId}/`) as Promise<
            Record<string, unknown>
          >,
          sentryFetch(config, `/issues/${issueId}/events/latest/`) as Promise<
            Record<string, unknown>
          >,
        ]);

        const stacktrace = extractStacktrace(latestEvent);
        const tags = (latestEvent.tags || []) as Array<{
          key: string;
          value: string;
        }>;
        const contexts = (latestEvent.contexts || {}) as Record<
          string,
          unknown
        >;
        const breadcrumbs = extractBreadcrumbs(latestEvent);

        return json({
          issue: {
            id: issue.id,
            shortId: issue.shortId,
            title: issue.title,
            culprit: issue.culprit,
            level: issue.level,
            count: issue.count,
            userCount: issue.userCount,
            firstSeen: issue.firstSeen,
            lastSeen: issue.lastSeen,
            status: issue.status,
            substatus: issue.substatus,
            isRegression: issue.isRegression,
            priority: issue.priority,
            project: (issue.project as Record<string, unknown>)?.slug,
          },
          latestEvent: {
            eventId: latestEvent.eventID,
            message: latestEvent.message || latestEvent.title,
            stacktrace,
            breadcrumbs,
            tags: Object.fromEntries(tags.map((t) => [t.key, t.value])),
            otelContext: contexts.otel || null,
            runtime: contexts.runtime || null,
          },
          crossLinks: {
            traceId:
              tags.find((t) => t.key === 'trace_id')?.value || null,
            runId: tags.find((t) => t.key === 'run_id')?.value || null,
            service:
              tags.find((t) => t.key === 'service')?.value || null,
            environment:
              tags.find((t) => t.key === 'environment')?.value || null,
          },
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  3. sentry_get_issue_events                                        */
/* ------------------------------------------------------------------ */

export function createSentryGetIssueEventsTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_get_issue_events',
    description:
      'Get recent events for a Sentry issue. Detects temporal patterns (burst, steady, regression).',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID' },
      limit: { type: 'number', min: 1, max: 100, default: 25, required: false },
    },
    execute: async ({ issueId, limit = 25 }) => {
      try {
        const events = (await sentryFetch(
          config,
          `/issues/${issueId}/events/?limit=${limit}`,
        )) as Array<Record<string, unknown>>;

        const mapped = events.map((e) => {
          const tags = (e.tags || []) as Array<{
            key: string;
            value: string;
          }>;
          return {
            eventId: e.eventID,
            timestamp: e.dateCreated,
            message: e.message || e.title,
            traceId: tags.find((t) => t.key === 'trace_id')?.value,
            runId: tags.find((t) => t.key === 'run_id')?.value,
            service: tags.find((t) => t.key === 'service')?.value,
            environment: tags.find((t) => t.key === 'environment')?.value,
            release: tags.find((t) => t.key === 'release')?.value,
          };
        });

        const pattern = detectTemporalPattern(
          mapped.map((e) => e.timestamp as string),
        );
        const services = [
          ...new Set(mapped.map((e) => e.service).filter(Boolean)),
        ];
        const environments = [
          ...new Set(mapped.map((e) => e.environment).filter(Boolean)),
        ];

        return json({
          total: mapped.length,
          pattern,
          affectedServices: services,
          affectedEnvironments: environments,
          events: mapped,
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  4. sentry_resolve_issue                                           */
/* ------------------------------------------------------------------ */

export function createSentryResolveIssueTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_resolve_issue',
    description:
      'Update a Sentry issue status: resolve, ignore, or unresolve.',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID' },
      action: { type: 'enum', values: ['resolve', 'ignore', 'unresolve'] },
      ignoreDuration: {
        type: 'number',
        required: false,
        description: 'Minutes to ignore (omit = forever)',
      },
    },
    execute: async ({ issueId, action, ignoreDuration }) => {
      try {
        let body: Record<string, unknown>;
        if (action === 'resolve') body = { status: 'resolved' };
        else if (action === 'ignore')
          body = ignoreDuration
            ? { status: 'ignored', statusDetails: { ignoreDuration } }
            : { status: 'ignored' };
        else body = { status: 'unresolved' };

        const result = await sentryFetch(config, `/issues/${issueId}/`, {
          method: 'PUT',
          body,
        });
        return json({ success: true, action, issueId, result });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  5. sentry_search_by_trace                                         */
/* ------------------------------------------------------------------ */

export function createSentrySearchByTraceTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_search_by_trace',
    description:
      'Find all Sentry errors linked to a specific OTel trace ID across projects.',
    params: {
      traceId: {
        type: 'string',
        description: 'OTel trace ID (32-char hex)',
      },
      project: {
        type: 'string',
        required: false,
        description: 'Limit to specific project',
      },
    },
    execute: async ({ traceId, project }) => {
      try {
        const query = `trace_id:${traceId}`;
        const projectFilter = project ? `&project=${project}` : '';
        const issues = (await sentryFetch(
          config,
          `/issues/?query=${encodeURIComponent(query)}${projectFilter}&limit=50`,
        )) as Array<Record<string, unknown>>;

        const results = issues.map((i: Record<string, unknown>) => ({
          id: i.id,
          shortId: i.shortId,
          title: i.title,
          culprit: i.culprit,
          level: i.level,
          count: i.count,
          project: (i.project as Record<string, unknown>)?.slug,
          firstSeen: i.firstSeen,
          lastSeen: i.lastSeen,
        }));

        return json({
          traceId,
          issuesFound: results.length,
          issues: results,
          hint:
            results.length === 0
              ? 'No Sentry errors found for this trace. Verify enrichSentryEvent() is called in beforeSend.'
              : null,
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  6. sentry_project_stats                                           */
/* ------------------------------------------------------------------ */

export function createSentryProjectStatsTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const projects = config.sentry.projects;

  return {
    name: 'sentry_project_stats',
    description:
      'Get error rate trends for a Sentry project over a time range.',
    params: {
      project:
        projects.length > 0
          ? { type: 'enum', values: projects, description: 'Sentry project slug' }
          : { type: 'string', description: 'Sentry project slug' },
      stat: {
        type: 'enum',
        values: ['received', 'rejected', 'blacklisted'],
        default: 'received',
        required: false,
      },
      interval: {
        type: 'enum',
        values: ['1h', '1d'],
        default: '1d',
        required: false,
      },
      period: {
        type: 'string',
        default: '14d',
        required: false,
        description: 'Lookback period (e.g., "7d", "14d")',
      },
    },
    execute: async ({
      project,
      stat = 'received',
      interval = '1d',
      period = '14d',
    }) => {
      try {
        const data = await sentryFetch(
          config,
          `/stats_v2/?project=${project}&field=sum(quantity)&category=error&outcome=${stat}&interval=${interval}&statsPeriod=${period}`,
        );
        return json({ project, stat, interval, period, data });
      } catch (e) {
        return err(e);
      }
    },
  };
}
