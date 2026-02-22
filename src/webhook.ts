/**
 * Webhook server — receives Sentry alert webhooks, auto-triages, and
 * optionally auto-resolves known issues.
 */

import { createServer, type Server as HttpServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AgentConfig } from './config.js'
import { sentryFetch, extractStacktrace, extractBreadcrumbs, resolveIssue } from './helpers.js'
import { buildDiagnosis, type DiagnosisInput } from './tools/diagnosis.js'
import { shouldAutoResolve } from './auto-resolve.js'

/* ─── Logging (stderr only — stdout is MCP stdio) ──── */

function log(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
  const entry = { ts: new Date().toISOString(), level, component: 'webhook', msg, ...(data ? { data } : {}) }
  process.stderr.write(JSON.stringify(entry) + '\n')
}

/* ─── Rate Limiter ─────────────────────────────────── */

class RateLimiter {
  private records: Array<{ issueId: string; category: string; timestamp: number }> = []
  constructor(private maxPerHour: number) {}

  canResolve(): boolean {
    this.prune()
    return this.records.length < this.maxPerHour
  }

  record(issueId: string, category: string): void {
    this.records.push({ issueId, category, timestamp: Date.now() })
  }

  private prune(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    this.records = this.records.filter(r => r.timestamp > oneHourAgo)
  }

  get count(): number {
    this.prune()
    return this.records.length
  }
}

/* ─── Signature Verification ───────────────────────── */

function verifySentrySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  if (!secret) {
    log('warn', 'No SENTRY_WEBHOOK_SECRET configured — skipping signature verification')
    return true
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const received = signatureHeader.replace('sha256=', '')
  if (expected.length !== received.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

/* ─── Webhook Handler ──────────────────────────────── */

async function handleSentryWebhook(
  config: AgentConfig,
  payload: Record<string, unknown>,
  rateLimiter: RateLimiter,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const action = String(payload.action || '')
  const issueData = (payload.data as Record<string, unknown>)?.issue as Record<string, unknown> | undefined

  if (!issueData) {
    return { status: 200, body: { accepted: true, action: 'skipped', reason: 'No issue data in payload' } }
  }

  // Only process triggered alerts (new issues / alert fires)
  if (action !== 'triggered' && action !== 'created') {
    log('info', `Ignoring webhook action: ${action}`)
    return { status: 200, body: { accepted: true, action: 'skipped', reason: `Action "${action}" not processed` } }
  }

  const issueId = String(issueData.id || '')
  const project = (issueData.project as Record<string, unknown>)?.slug as string || 'unknown'

  log('info', `Processing Sentry alert for issue ${issueId} in ${project}`, { action })

  // Fetch latest event for stack trace
  let stacktrace: string[] = []
  let breadcrumbs: DiagnosisInput['breadcrumbs'] = []
  let tags: Array<{ key: string; value: string }> = []

  try {
    const latestEvent = await sentryFetch(config, `/issues/${issueId}/events/latest/`) as Record<string, unknown>
    stacktrace = extractStacktrace(latestEvent)
    breadcrumbs = extractBreadcrumbs(latestEvent)
    tags = (latestEvent.tags || []) as Array<{ key: string; value: string }>
  } catch (e) {
    log('warn', `Could not fetch latest event for issue ${issueId}`, { error: String(e) })
  }

  // Run diagnosis
  const diagnosis = buildDiagnosis(config, {
    title: String(issueData.title || ''),
    culprit: String(issueData.culprit || ''),
    count: Number(issueData.count || 0),
    userCount: Number(issueData.userCount || 0),
    level: String(issueData.level || 'error'),
    stacktrace,
    breadcrumbs,
    tags,
    firstSeen: String(issueData.firstSeen || ''),
    lastSeen: String(issueData.lastSeen || ''),
    project,
  })

  log('info', `Diagnosis: [${diagnosis.severity}] ${diagnosis.category}`, { issueId, rootCause: diagnosis.rootCause })

  // Check auto-resolve
  const decision = shouldAutoResolve(config, diagnosis)

  if (decision.shouldResolve && rateLimiter.canResolve()) {
    try {
      await resolveIssue(config, issueId, decision.action === 'ignore' ? 'ignore' : 'resolve', decision.ignoreDuration)
      rateLimiter.record(issueId, diagnosis.category)
      log('info', `Auto-resolved issue ${issueId}`, { category: diagnosis.category, reason: decision.reason })
      return {
        status: 200,
        body: { accepted: true, action: 'auto_resolved', issueId, category: diagnosis.category, reason: decision.reason, diagnosis: diagnosis.summary },
      }
    } catch (e) {
      log('error', `Failed to auto-resolve issue ${issueId}`, { error: String(e) })
    }
  } else if (decision.shouldResolve && !rateLimiter.canResolve()) {
    log('warn', `Rate limit reached — skipping auto-resolve for ${issueId}`, { count: rateLimiter.count })
  }

  return {
    status: 200,
    body: { accepted: true, action: 'triaged', issueId, category: diagnosis.category, severity: diagnosis.severity, autoResolve: decision },
  }
}

/* ─── Express Server ───────────────────────────────── */

export async function startWebhookServer(config: AgentConfig): Promise<HttpServer> {
  const port = config.webhook.port
  const host = config.webhook.host

  const secret = config.webhook.sentrySecret === 'from-env'
    ? (process.env.SENTRY_WEBHOOK_SECRET || '')
    : config.webhook.sentrySecret

  const rateLimiter = new RateLimiter(config.webhook.autoResolve.maxAutoResolvePerHour)
  const startTime = Date.now()

  const server = createServer(async (req, res) => {
    const url = req.url || ''
    const method = req.method || ''

    // Health endpoint
    if (method === 'GET' && url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.round((Date.now() - startTime) / 1000),
        autoResolveCount: rateLimiter.count,
        maxAutoResolvePerHour: config.webhook.autoResolve.maxAutoResolvePerHour,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }

    // Sentry webhook
    if (method === 'POST' && url === '/webhooks/sentry') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const rawBody = Buffer.concat(chunks)
          const signatureHeader = (req.headers['sentry-hook-signature'] || '') as string

          if (secret && !verifySentrySignature(rawBody, signatureHeader, secret)) {
            log('warn', 'Invalid webhook signature')
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid signature' }))
            return
          }

          const payload = JSON.parse(rawBody.toString('utf-8'))
          const result = await handleSentryWebhook(config, payload, rateLimiter)
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.body))
        } catch (e) {
          log('error', 'Webhook handler error', { error: String(e) })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
      return
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log('info', `Webhook server listening on ${host}:${port}`)
      resolve(server)
    })
  })
}
