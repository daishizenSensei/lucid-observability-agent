/**
 * Periodic health check scheduler.
 * Runs configured checks at regular intervals and optionally posts results
 * to a notification URL (Slack webhook, etc.).
 */

import type { AgentConfig } from './config.js'
import { sentryFetch, getPgPool } from './helpers.js'

/* ─── Logging (stderr only) ────────────────────────── */

function log(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
  const entry = { ts: new Date().toISOString(), level, component: 'scheduler', msg, ...(data ? { data } : {}) }
  process.stderr.write(JSON.stringify(entry) + '\n')
}

/* ─── Types ────────────────────────────────────────── */

interface CheckResult {
  check: string
  status: 'ok' | 'warn' | 'critical'
  message: string
  details?: unknown
}

/* ─── Check Implementations ────────────────────────── */

async function checkOutboxHealth(config: AgentConfig): Promise<CheckResult> {
  const pool = await getPgPool()
  const table = config.metering.outboxTable
  const dlThreshold = config.metering.deadLetterThreshold
  const queueThreshold = config.metering.queueDepthThreshold

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE sent_at IS NULL AND attempts < ${dlThreshold}) AS pending,
      COUNT(*) FILTER (WHERE attempts >= ${dlThreshold}) AS dead_letter,
      COUNT(*) FILTER (WHERE lease_until < now() - interval '5 minutes' AND sent_at IS NULL AND attempts < ${dlThreshold}) AS stuck
    FROM ${table}
    WHERE created_at > now() - interval '1 hour'
  `)

  const row = result.rows[0] || {}
  const pending = parseInt(row.pending || '0')
  const deadLetter = parseInt(row.dead_letter || '0')
  const stuck = parseInt(row.stuck || '0')

  const problems: string[] = []
  if (pending > queueThreshold) problems.push(`${pending} pending (threshold: ${queueThreshold})`)
  if (deadLetter > 0) problems.push(`${deadLetter} dead letters`)
  if (stuck > 0) problems.push(`${stuck} stuck leases`)

  if (deadLetter > 0 || stuck > 0) {
    return { check: 'outbox_health', status: 'critical', message: problems.join('; '), details: { pending, deadLetter, stuck } }
  }
  if (pending > queueThreshold) {
    return { check: 'outbox_health', status: 'warn', message: problems.join('; '), details: { pending, deadLetter, stuck } }
  }
  return { check: 'outbox_health', status: 'ok', message: `Healthy: ${pending} pending, 0 dead letters`, details: { pending, deadLetter, stuck } }
}

async function checkErrorSpike(config: AgentConfig): Promise<CheckResult> {
  const projects = config.sentry.projects
  if (projects.length === 0) {
    return { check: 'error_spike', status: 'ok', message: 'No Sentry projects configured' }
  }

  const spikes: Array<{ project: string; issueId: string; title: string; count: number }> = []

  for (const project of projects) {
    try {
      const issues = await sentryFetch(config,
        `/issues/?project=${project}&query=is:unresolved&sort=freq&limit=5`
      ) as Array<Record<string, unknown>>

      for (const issue of issues) {
        const count = Number(issue.count || 0)
        if (count > 100) {
          spikes.push({
            project,
            issueId: String(issue.id),
            title: String(issue.title || '').slice(0, 80),
            count,
          })
        }
      }
    } catch {
      // Skip projects that fail — don't break the whole check
    }
  }

  if (spikes.length > 0) {
    return {
      check: 'error_spike',
      status: 'warn',
      message: `${spikes.length} high-frequency issues detected`,
      details: spikes,
    }
  }
  return { check: 'error_spike', status: 'ok', message: 'No error spikes detected' }
}

async function checkDeadLetters(config: AgentConfig): Promise<CheckResult> {
  const pool = await getPgPool()
  const table = config.metering.outboxTable
  const dlThreshold = config.metering.deadLetterThreshold

  const result = await pool.query(`
    SELECT last_error, COUNT(*) AS count
    FROM ${table}
    WHERE attempts >= ${dlThreshold} AND sent_at IS NULL
    GROUP BY last_error
    ORDER BY count DESC
    LIMIT 5
  `)

  const total = result.rows.reduce((sum: number, r: Record<string, unknown>) => sum + parseInt(String(r.count || '0')), 0)

  if (total > 0) {
    return {
      check: 'dead_letters',
      status: 'critical',
      message: `${total} dead letter events need attention`,
      details: result.rows,
    }
  }
  return { check: 'dead_letters', status: 'ok', message: 'No dead letters' }
}

/* ─── Check Registry ───────────────────────────────── */

const CHECK_REGISTRY: Record<string, (config: AgentConfig) => Promise<CheckResult>> = {
  outbox_health: checkOutboxHealth,
  error_spike: checkErrorSpike,
  dead_letters: checkDeadLetters,
}

/* ─── Notification ─────────────────────────────────── */

async function notify(url: string, results: CheckResult[]): Promise<void> {
  const problems = results.filter(r => r.status !== 'ok')
  if (problems.length === 0) return

  const text = problems
    .map(p => `*[${p.status.toUpperCase()}]* ${p.check}: ${p.message}`)
    .join('\n')

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Observability Agent Alert\n${text}` }),
    })
  } catch (e) {
    log('error', 'Failed to send notification', { error: String(e) })
  }
}

/* ─── Scheduler ────────────────────────────────────── */

async function runChecks(config: AgentConfig): Promise<void> {
  const enabledChecks = config.periodicChecks.checks
  const results: CheckResult[] = []

  for (const checkName of enabledChecks) {
    const checkFn = CHECK_REGISTRY[checkName]
    if (!checkFn) {
      log('warn', `Unknown check: ${checkName}`)
      continue
    }

    try {
      const result = await checkFn(config)
      results.push(result)
      if (result.status !== 'ok') {
        log('warn', `Check ${checkName}: ${result.status} — ${result.message}`, result.details)
      } else {
        log('info', `Check ${checkName}: ok`)
      }
    } catch (e) {
      log('error', `Check ${checkName} failed`, { error: String(e) })
      results.push({ check: checkName, status: 'critical', message: `Check failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  if (config.periodicChecks.notifyUrl) {
    await notify(config.periodicChecks.notifyUrl, results)
  }
}

export function startScheduler(config: AgentConfig): { stop: () => void } {
  const intervalMs = config.periodicChecks.intervalMinutes * 60 * 1000

  log('info', `Scheduler started: running ${config.periodicChecks.checks.join(', ')} every ${config.periodicChecks.intervalMinutes}m`)

  // Run immediately on startup
  runChecks(config).catch(e => log('error', 'Initial check run failed', { error: String(e) }))

  const timer = setInterval(() => {
    runChecks(config).catch(e => log('error', 'Scheduled check run failed', { error: String(e) }))
  }, intervalMs)

  return {
    stop: () => {
      clearInterval(timer)
      log('info', 'Scheduler stopped')
    },
  }
}
