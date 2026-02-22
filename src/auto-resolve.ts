/**
 * Auto-resolve decision engine.
 * Given a diagnosis result, determines whether the issue should be auto-resolved.
 */

import type { AgentConfig } from './config.js'

export interface DiagnosisResult {
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  rootCause: string
  suggestions: Array<{ action: string; description: string; confidence: string }>
}

export interface AutoResolveDecision {
  shouldResolve: boolean
  reason: string
  action: 'resolve' | 'ignore' | 'none'
  ignoreDuration?: number
}

export function shouldAutoResolve(
  config: AgentConfig,
  diagnosis: DiagnosisResult,
): AutoResolveDecision {
  const autoResolve = config.webhook.autoResolve
  if (!autoResolve.enabled) {
    return { shouldResolve: false, reason: 'Auto-resolve disabled in config', action: 'none' }
  }

  // Never auto-resolve critical or high severity
  if (diagnosis.severity === 'critical' || diagnosis.severity === 'high') {
    return {
      shouldResolve: false,
      reason: `Severity is ${diagnosis.severity} — requires human review`,
      action: 'none',
    }
  }

  // Check for known bugs marked as fixed
  const hasKnownBugSuggestion = diagnosis.suggestions.some(s => s.action === 'known_bug')
  if (hasKnownBugSuggestion) {
    const isFixed = config.knownBugs.some(b =>
      b.fixed && b.keywords.some(kw =>
        diagnosis.summary.toLowerCase().includes(kw) ||
        diagnosis.rootCause.toLowerCase().includes(kw)
      )
    )
    if (isFixed) {
      return {
        shouldResolve: true,
        reason: 'Matches a known bug marked as fixed',
        action: 'resolve',
      }
    }
  }

  // Check category-based auto-resolve
  if (autoResolve.categories.includes(diagnosis.category)) {
    return {
      shouldResolve: true,
      reason: `Category "${diagnosis.category}" in auto-resolve list, severity is ${diagnosis.severity}`,
      action: 'resolve',
    }
  }

  return { shouldResolve: false, reason: 'Category not in auto-resolve list', action: 'none' }
}
