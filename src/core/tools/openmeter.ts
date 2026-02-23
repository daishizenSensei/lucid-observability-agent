/**
 * OpenMeter tools -- outbox health, usage analytics, dead letter recovery, anomaly detection.
 * Converted from Zod+server.tool() to ToolParamDef factory functions.
 */

import type { ToolDefinition } from './types.js';
import type { AgentConfig } from '../types/config.js';
import { getPgPool } from '../helpers/postgres.js';
import { json, err } from '../helpers/response.js';

interface ToolDeps {
  config: AgentConfig;
}

/* ------------------------------------------------------------------ */
/*  1. openmeter_outbox_health                                        */
/* ------------------------------------------------------------------ */

export function createOutboxHealthTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const table = config.metering.outboxTable;

  return {
    name: 'openmeter_outbox_health',
    description:
      'Check OpenMeter outbox queue health: pending events, dead letters, stuck leases, throughput.',
    params: {
      hours: {
        type: 'number',
        min: 1,
        max: 168,
        default: 24,
        required: false,
        description: 'Lookback hours',
      },
    },
    execute: async ({ hours = 24 }) => {
      try {
        const pool = await getPgPool();
        const threshold = config.metering.queueDepthThreshold;
        const dlThreshold = config.metering.deadLetterThreshold;

        const [queueResult, rateResult, stuckResult, errorResult] =
          await Promise.all([
            pool.query(`
            SELECT
              COUNT(*) FILTER (WHERE sent_at IS NULL AND attempts < ${dlThreshold}) AS pending,
              COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS sent,
              COUNT(*) FILTER (WHERE attempts >= ${dlThreshold}) AS dead_letter,
              COUNT(*) FILTER (WHERE lease_until IS NOT NULL AND lease_until > now()) AS leased,
              COUNT(*) AS total
            FROM ${table}
            WHERE created_at > now() - interval '${hours} hours'
          `),
            pool.query(`
            SELECT date_trunc('hour', sent_at) AS hour, COUNT(*) AS events_sent
            FROM ${table}
            WHERE sent_at > now() - interval '${Math.min(hours, 24)} hours'
            GROUP BY 1 ORDER BY 1 DESC LIMIT 24
          `),
            pool.query(`
            SELECT COUNT(*) AS stuck_count FROM ${table}
            WHERE lease_until < now() - interval '5 minutes' AND sent_at IS NULL AND attempts < ${dlThreshold}
          `),
            pool.query(`
            SELECT last_error, COUNT(*) AS count FROM ${table}
            WHERE attempts > 0 AND created_at > now() - interval '${hours} hours'
            GROUP BY last_error ORDER BY count DESC LIMIT 5
          `),
          ]);

        const queue = queueResult.rows[0] || {};
        const pending = parseInt(queue.pending || '0');
        const deadLetter = parseInt(queue.dead_letter || '0');
        const stuck = parseInt(stuckResult.rows[0]?.stuck_count || '0');

        const anomalies: string[] = [];
        if (pending > threshold)
          anomalies.push(
            `HIGH QUEUE DEPTH: ${pending} pending (threshold: ${threshold})`,
          );
        if (deadLetter > 0)
          anomalies.push(
            `DEAD LETTERS: ${deadLetter} events failed ${dlThreshold}+ times`,
          );
        if (stuck > 0)
          anomalies.push(
            `STUCK LEASES: ${stuck} events with expired leases — outbox worker may be down`,
          );
        if (
          parseInt(queue.sent || '0') === 0 &&
          parseInt(queue.total || '0') > 0
        ) {
          anomalies.push(
            'NO EVENTS SENT: Events created but none delivered — check API connectivity',
          );
        }

        return json({
          timeRange: `Last ${hours} hours`,
          queue: {
            total: parseInt(queue.total || '0'),
            pending,
            sent: parseInt(queue.sent || '0'),
            deadLetter,
            currentlyLeased: parseInt(queue.leased || '0'),
            stuckLeases: stuck,
          },
          throughputPerHour: rateResult.rows,
          topErrors: errorResult.rows,
          anomalies,
          healthy: anomalies.length === 0,
          recommendations:
            anomalies.length > 0
              ? [
                  ...(deadLetter > 0
                    ? [
                        'Use openmeter_dead_letter_retry to retry failed events',
                      ]
                    : []),
                  ...(stuck > 0
                    ? ['Check outbox worker process — may need restart']
                    : []),
                  ...(pending > threshold
                    ? [
                        'Consider increasing batch_size or reducing interval_ms',
                      ]
                    : []),
                ]
              : ['Outbox is healthy — all metrics normal'],
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  2. openmeter_usage_by_org                                         */
/* ------------------------------------------------------------------ */

export function createUsageByOrgTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const table = config.metering.outboxTable;

  return {
    name: 'openmeter_usage_by_org',
    description:
      'Per-org usage breakdown: tokens, tool calls, costs by provider and model.',
    params: {
      hours: { type: 'number', min: 1, max: 720, default: 24, required: false },
      orgId: {
        type: 'string',
        required: false,
        description: 'Filter to specific org UUID',
      },
    },
    execute: async ({ hours = 24, orgId }) => {
      try {
        const pool = await getPgPool();
        const orgFilter = orgId ? `AND org_id = '${orgId}'` : '';

        const [tokenResult, otherResult] = await Promise.all([
          pool.query(`
            SELECT org_id, provider_name, model_family, status_bucket,
              COUNT(*) AS request_count, SUM(total_tokens) AS total_tokens,
              SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
              MIN(created_at) AS first_event, MAX(created_at) AS last_event
            FROM ${table}
            WHERE created_at > now() - interval '${hours} hours' AND feature = 'chat_completion' ${orgFilter}
            GROUP BY org_id, provider_name, model_family, status_bucket
            ORDER BY total_tokens DESC NULLS LAST LIMIT 50
          `),
          pool.query(`
            SELECT org_id, service, feature, status_bucket,
              COUNT(*) AS call_count, MIN(created_at) AS first_event, MAX(created_at) AS last_event
            FROM ${table}
            WHERE created_at > now() - interval '${hours} hours' AND feature != 'chat_completion' ${orgFilter}
            GROUP BY org_id, service, feature, status_bucket
            ORDER BY call_count DESC LIMIT 50
          `),
        ]);

        return json({
          timeRange: `Last ${hours} hours`,
          orgFilter: orgId || 'all',
          llmUsage: tokenResult.rows,
          otherUsage: otherResult.rows,
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  3. openmeter_dead_letter_retry                                    */
/* ------------------------------------------------------------------ */

export function createDeadLetterRetryTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const table = config.metering.outboxTable;

  return {
    name: 'openmeter_dead_letter_retry',
    description:
      'Retry dead-letter events that have failed max attempts. Resets attempt count so the outbox worker picks them up again.',
    params: {
      maxEvents: {
        type: 'number',
        min: 1,
        max: 500,
        default: 100,
        required: false,
      },
      orgId: {
        type: 'string',
        required: false,
        description: 'Filter to specific org',
      },
    },
    execute: async ({ maxEvents = 100, orgId }) => {
      try {
        const pool = await getPgPool();
        const orgFilter = orgId ? `AND org_id = '${orgId}'` : '';
        const dlThreshold = config.metering.deadLetterThreshold;

        const result = await pool.query(`
          UPDATE ${table}
          SET attempts = 0, lease_until = NULL, lease_owner = NULL, last_error = NULL
          WHERE id IN (
            SELECT id FROM ${table}
            WHERE attempts >= ${dlThreshold} AND sent_at IS NULL ${orgFilter}
            ORDER BY created_at ASC LIMIT ${maxEvents}
          )
          RETURNING id, org_id, created_at, last_error
        `);

        return json({
          retriedCount: result.rowCount,
          events: result.rows,
          note:
            result.rowCount && result.rowCount > 0
              ? 'Events reset — outbox worker will pick them up on next tick.'
              : 'No dead-letter events found to retry.',
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  4. openmeter_usage_anomaly                                        */
/* ------------------------------------------------------------------ */

export function createUsageAnomalyTool(deps: ToolDeps): ToolDefinition {
  const { config } = deps;
  const table = config.metering.outboxTable;

  return {
    name: 'openmeter_usage_anomaly',
    description:
      'Detect usage anomalies: sudden spikes or drops in token usage per org compared to rolling average.',
    params: {
      hours: {
        type: 'number',
        min: 1,
        max: 168,
        default: 24,
        required: false,
        description: 'Recent window',
      },
      baselineHours: {
        type: 'number',
        min: 24,
        max: 720,
        default: 168,
        required: false,
        description: 'Baseline window',
      },
      spikeThreshold: {
        type: 'number',
        min: 1,
        default: 3,
        required: false,
        description: 'Multiple above avg to flag',
      },
    },
    execute: async ({
      hours = 24,
      baselineHours = 168,
      spikeThreshold = 3,
    }) => {
      try {
        const pool = await getPgPool();

        const result = await pool.query(`
          WITH recent AS (
            SELECT org_id, SUM(total_tokens) AS recent_tokens, COUNT(*) AS recent_requests
            FROM ${table} WHERE created_at > now() - interval '${hours} hours' GROUP BY org_id
          ),
          baseline AS (
            SELECT org_id,
              SUM(total_tokens) / GREATEST(EXTRACT(EPOCH FROM interval '${baselineHours} hours') / EXTRACT(EPOCH FROM interval '${hours} hours'), 1) AS avg_tokens,
              COUNT(*) / GREATEST(EXTRACT(EPOCH FROM interval '${baselineHours} hours') / EXTRACT(EPOCH FROM interval '${hours} hours'), 1) AS avg_requests
            FROM ${table}
            WHERE created_at > now() - interval '${baselineHours} hours' AND created_at <= now() - interval '${hours} hours'
            GROUP BY org_id
          )
          SELECT COALESCE(r.org_id, b.org_id) AS org_id,
            r.recent_tokens, r.recent_requests, b.avg_tokens AS baseline_tokens, b.avg_requests AS baseline_requests,
            CASE WHEN b.avg_tokens > 0 THEN ROUND((r.recent_tokens / b.avg_tokens)::numeric, 2) ELSE NULL END AS token_ratio,
            CASE WHEN b.avg_requests > 0 THEN ROUND((r.recent_requests / b.avg_requests)::numeric, 2) ELSE NULL END AS request_ratio
          FROM recent r FULL OUTER JOIN baseline b ON r.org_id = b.org_id
          ORDER BY COALESCE(r.recent_tokens, 0) DESC LIMIT 50
        `);

        const anomalies = result.rows.filter(
          (r: Record<string, unknown>) => {
            const ratio = parseFloat(String(r.token_ratio || '0'));
            return (
              ratio >= spikeThreshold ||
              (r.baseline_tokens && !r.recent_tokens)
            );
          },
        );

        return json({
          timeRange: `Recent ${hours}h vs baseline ${baselineHours}h`,
          spikeThreshold: `${spikeThreshold}x average`,
          anomaliesFound: anomalies.length,
          anomalies: anomalies.map((a: Record<string, unknown>) => ({
            ...a,
            type: !a.recent_tokens
              ? 'DROP (no recent usage)'
              : `SPIKE (${a.token_ratio}x baseline)`,
          })),
          allOrgs: result.rows,
        });
      } catch (e) {
        return err(e);
      }
    },
  };
}
