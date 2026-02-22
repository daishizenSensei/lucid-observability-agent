/**
 * Configuration schema and loader for the Lucid Observability Agent.
 *
 * Config is loaded from (in order of precedence):
 *   1. AGENT_CONFIG_PATH env var → custom JSON file
 *   2. ./config/lucid.json (default Lucid platform config)
 *   3. Built-in minimal defaults
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ─── Types ───────────────────────────────────────────── */

export interface ServiceInfo {
  repo: string
  runtime: string
  framework: string
  sentryProject: string
}

export interface AttributeKeyInfo {
  description: string
  pii: boolean
  highCardinality: boolean
}

export interface RunbookPhase {
  title: string
  severity: string
  triage: string[]
  diagnose: string[]
  mitigate: string[]
  resolve: string[]
  postmortem: string[]
}

export interface DiagnosisPattern {
  category: string
  keywords: string[]
  rootCause: string
  suggestions: Array<{ action: string; description: string; confidence: 'high' | 'medium' | 'low'; command?: string }>
  relatedPatterns: string[]
}

export interface KnownBug {
  id: string
  title: string
  keywords: string[]
  description: string
  fix: string
  fixed: boolean
}

export interface AgentConfig {
  platform: {
    name: string
    envVar: string
  }
  sentry: {
    defaultOrg: string
    projects: string[]
  }
  services: Record<string, ServiceInfo>
  conventions: {
    spanNames: Record<string, string>
    attributeKeys: Record<string, AttributeKeyInfo>
    rules: string[]
  }
  dependencies: Record<string, string[]>
  traceFlow: string[]
  sampling: Record<string, number>
  runbooks: Record<string, RunbookPhase>
  diagnosisPatterns: DiagnosisPattern[]
  knownBugs: KnownBug[]
  metering: {
    outboxTable: string
    deadLetterThreshold: number
    queueDepthThreshold: number
  }
}

/* ─── Minimal built-in defaults ───────────────────────── */

const MINIMAL_DEFAULTS: AgentConfig = {
  platform: { name: 'app', envVar: 'NODE_ENV' },
  sentry: { defaultOrg: '', projects: [] },
  services: {},
  conventions: { spanNames: {}, attributeKeys: {}, rules: [] },
  dependencies: {},
  traceFlow: [],
  sampling: { production: 0.1, staging: 1.0, development: 1.0, test: 0.0 },
  runbooks: {},
  diagnosisPatterns: [],
  knownBugs: [],
  metering: { outboxTable: 'openmeter_event_ledger', deadLetterThreshold: 10, queueDepthThreshold: 500 },
}

/* ─── Loader ──────────────────────────────────────────── */

let _config: AgentConfig | null = null

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const bVal = base[key]
    const oVal = override[key]
    if (bVal && oVal && typeof bVal === 'object' && typeof oVal === 'object' && !Array.isArray(bVal) && !Array.isArray(oVal)) {
      result[key] = deepMerge(bVal as Record<string, unknown>, oVal as Record<string, unknown>)
    } else {
      result[key] = oVal
    }
  }
  return result
}

function tryLoadJson(path: string): Record<string, unknown> | null {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as Record<string, unknown>
    }
  } catch (e) {
    console.warn(`[config] Failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return null
}

export function loadConfig(): AgentConfig {
  if (_config) return _config

  let merged: Record<string, unknown> = MINIMAL_DEFAULTS as unknown as Record<string, unknown>

  // Try loading default config relative to package root
  const thisDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(thisDir, '..')
  const defaultConfigPath = resolve(packageRoot, 'config', 'lucid.json')
  const defaultJson = tryLoadJson(defaultConfigPath)
  if (defaultJson) {
    merged = deepMerge(merged, defaultJson)
  }

  // Override with custom config if specified
  const customPath = process.env.AGENT_CONFIG_PATH
  if (customPath) {
    const customJson = tryLoadJson(resolve(customPath))
    if (customJson) {
      merged = deepMerge(merged, customJson)
    } else {
      console.warn(`[config] AGENT_CONFIG_PATH="${customPath}" not found or invalid — using defaults`)
    }
  }

  _config = merged as unknown as AgentConfig
  return _config
}

/** Reset config cache (for testing) */
export function resetConfig(): void {
  _config = null
}
