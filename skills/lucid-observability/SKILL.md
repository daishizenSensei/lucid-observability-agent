# Lucid Observability Agent

Tools for monitoring, diagnosing, and resolving observability issues across Sentry, OpenMeter, and OpenTelemetry.

## Available Tools

### Sentry (6)
- `sentry_list_issues` — List issues by project with search syntax
- `sentry_get_issue` — Full detail with stack trace and cross-links
- `sentry_get_issue_events` — Event history with temporal pattern detection
- `sentry_resolve_issue` — Resolve, ignore, or unresolve
- `sentry_search_by_trace` — Find errors by OTel trace ID
- `sentry_project_stats` — Error rate trends over time

### Diagnosis (2)
- `diagnose_issue` — Root cause analysis with pattern matching
- `cross_correlate` — Cross-service error correlation

### OpenMeter (4)
- `openmeter_outbox_health` — Queue depth, dead letters, stuck leases
- `openmeter_usage_by_org` — Per-org token/tool usage breakdown
- `openmeter_dead_letter_retry` — Retry failed dead-letter events
- `openmeter_usage_anomaly` — Spike/drop detection vs baseline

### Configuration (2)
- `check_config_health` — Audit env vars for production readiness
- `check_conventions` — Verify service conventions compliance

### Auto-Fix (2)
- `suggest_alert_rules` — Generate Sentry alert configs from patterns
- `generate_runbook` — Incident runbook for error categories

## Workflows

### Triage an Issue
1. `sentry_get_issue` for full details
2. `diagnose_issue` for root cause analysis
3. If trace_id exists, `cross_correlate` to check cascade
4. `sentry_get_issue_events` for temporal patterns
5. `generate_runbook` for the diagnosed category
6. If critical/high, `suggest_alert_rules` for coverage

### Production Readiness Audit
1. `check_config_health` with environment="production"
2. `check_conventions` for each service
3. `openmeter_outbox_health` (24h lookback)
4. `openmeter_usage_anomaly` for billing health
5. `suggest_alert_rules` for each Sentry project
6. `sentry_list_issues` for unresolved fatal errors

### Incident Response
1. **Assess**: `sentry_list_issues` sorted by priority, `cross_correlate` for blast radius
2. **Diagnose**: `diagnose_issue`, `generate_runbook`, `openmeter_outbox_health`
3. **Mitigate**: Follow runbook steps, `sentry_resolve_issue` when fixed
4. **Document**: Timeline, root cause, impact, follow-ups

## Heartbeat Checklist
Use these in your HEARTBEAT.md for autonomous monitoring:
- Run `openmeter_outbox_health` — alert if dead letters > 0 or stuck leases
- Run `sentry_list_issues` sorted by freq — flag issues with count > 100
- Run `check_config_health` — warn if any critical checks failing
- If issues found, run `diagnose_issue` and suggest resolution
