/**
 * Auto-fix tools -- alert rule generation and incident runbooks.
 * Converted from Zod+server.tool() to ToolParamDef factory functions.
 */

import type { ToolDefinition } from './types.js';
import type { AgentConfig } from '../types/config.js';
import { sentryFetch } from '../helpers/sentry.js';
import { json } from '../helpers/response.js';

interface ToolDeps {
  config: AgentConfig;
}

/* ------------------------------------------------------------------ */
/*  1. suggest_alert_rules                                            */
/* ------------------------------------------------------------------ */

export function createSuggestAlertRulesTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const projects = config.sentry.projects;

  return {
    name: 'suggest_alert_rules',
    description:
      'Generate Sentry alert rule configurations for a project based on error patterns.',
    params: {
      project:
        projects.length > 0
          ? { type: 'enum', values: projects, description: 'Sentry project' }
          : { type: 'string', description: 'Sentry project' },
      includeMetricAlerts: {
        type: 'boolean',
        default: true,
        required: false,
      },
    },
    execute: async ({ project, includeMetricAlerts = true }) => {
      let topErrors: Array<Record<string, unknown>> = [];
      try {
        topErrors = (await sentryFetch(
          config,
          `/issues/?project=${project}&query=is:unresolved&sort=freq&limit=10`,
        )) as Array<Record<string, unknown>>;
      } catch {
        /* non-critical */
      }

      const rules: Array<{
        name: string;
        type: 'issue' | 'metric';
        conditions: string;
        actions: string;
        frequency: string;
        rationale: string;
      }> = [];

      rules.push(
        {
          name: `[${project}] New Error`,
          type: 'issue',
          conditions: 'New issue created with level: error or fatal',
          actions: 'Notify #alerts Slack channel',
          frequency: 'Once per issue per hour',
          rationale: 'Catches regressions and new errors',
        },
        {
          name: `[${project}] Error Spike`,
          type: 'issue',
          conditions: 'Issue seen > 50 times in 5 minutes',
          actions: 'Notify #alerts-critical + PagerDuty',
          frequency: 'Once per issue per 30 min',
          rationale: 'Detects error storms',
        },
        {
          name: `[${project}] Regression`,
          type: 'issue',
          conditions: 'Previously resolved issue regressed',
          actions: 'Notify + assign to last resolver',
          frequency: 'Once per issue',
          rationale: 'Catches bugs that return',
        },
      );

      if (includeMetricAlerts) {
        rules.push({
          name: `[${project}] High Error Rate`,
          type: 'metric',
          conditions: 'Error count > 100 in 10 minutes',
          actions: 'Notify #alerts-critical',
          frequency: 'Every 10 min while active',
          rationale: 'Aggregate health threshold',
        });
      }

      for (const issue of topErrors.slice(0, 3)) {
        const title = String(issue.title || '');
        const count = Number(issue.count || 0);
        if (count > 50) {
          rules.push({
            name: `[${project}] Monitor: ${title.slice(0, 50)}`,
            type: 'issue',
            conditions: `Issue "${title.slice(0, 50)}..." > ${Math.ceil(count * 0.2)} times/hour`,
            actions: 'Notify #alerts',
            frequency: 'Every 1 hour while active',
            rationale: `Currently #${topErrors.indexOf(issue) + 1} most frequent (${count} events)`,
          });
        }
      }

      return json({
        project,
        totalRules: rules.length,
        rules,
        setupInstructions: [
          'Go to Sentry → Project Settings → Alerts',
          'Create each rule with the conditions specified',
          'Connect Slack/PagerDuty integration for notifications',
        ],
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/*  2. generate_runbook                                               */
/* ------------------------------------------------------------------ */

export function createGenerateRunbookTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const runbookCategories = Object.keys(config.runbooks);

  return {
    name: 'generate_runbook',
    description:
      'Generate an incident runbook for a specific error category with triage, diagnosis, mitigation, resolution, and postmortem steps.',
    params: {
      category:
        runbookCategories.length > 0
          ? {
              type: 'enum',
              values: runbookCategories,
              description: 'Error category',
            }
          : { type: 'string', description: 'Error category' },
      service: {
        type: 'string',
        required: false,
        description: 'Specific service context',
      },
    },
    execute: async ({ category, service }) => {
      const runbook = config.runbooks[category];
      if (!runbook) {
        // Fall back to generic runbook
        return json({
          category,
          service: service || 'all',
          title: `${category} Incident`,
          severity: 'MEDIUM',
          triage: [
            'Check Sentry for error volume and trend',
            'Identify affected services',
            'Check if it started after a deployment',
          ],
          diagnose: [
            'Use sentry_get_issue for full stack trace',
            'Use cross_correlate to check cascade',
            'Check logs for additional context',
          ],
          mitigate: [
            'If critical: rollback deployment',
            'If isolated: apply targeted fix',
            'Communicate status to affected users',
          ],
          resolve: [
            'Fix the root cause',
            'Deploy fix and verify',
            'Use sentry_resolve_issue when confirmed fixed',
          ],
          postmortem: [
            'Document timeline',
            'Check alert coverage with suggest_alert_rules',
            'Add test coverage for the scenario',
          ],
          relatedTools: [
            'sentry_list_issues',
            'sentry_get_issue',
            'cross_correlate',
            'check_config_health',
          ],
        });
      }

      return json({
        category,
        service: service || 'all',
        ...runbook,
        relatedTools: [
          'sentry_list_issues',
          'sentry_get_issue',
          'cross_correlate',
          'openmeter_outbox_health',
          'check_config_health',
        ],
      });
    },
  };
}
