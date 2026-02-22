# Lucid Observability Agent

MCP server for monitoring, diagnosing, and auto-correcting observability issues across platform services. Connects to **Sentry** for error tracking, **PostgreSQL** for OpenMeter billing pipeline health, and ships with AI-powered diagnosis, incident runbooks, and cross-service correlation.

Unlike the official Sentry MCP server (which is a pure API wrapper), this agent adds:

- **Root cause analysis** — pattern matching against error titles, stack traces, and platform-specific knowledge
- **Cross-service correlation** — traces errors across multiple services via `trace_id` / `run_id`
- **Billing pipeline monitoring** — outbox health, dead letter recovery, usage anomaly detection
- **Incident runbooks** — 10 error categories with 5-phase playbooks (triage → diagnose → mitigate → resolve → postmortem)
- **Alert rule generation** — suggests Sentry alert rules based on actual error patterns
- **Production readiness auditing** — validates env vars, conventions, and configuration

## Quick Start

```bash
npm install lucid-observability-agent
```

### Claude Desktop / Claude Code

Add to your MCP config (`~/.claude.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "observability": {
      "command": "npx",
      "args": ["lucid-observability-agent"],
      "env": {
        "SENTRY_AUTH_TOKEN": "sntrys_...",
        "SENTRY_ORG": "your-org",
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

Or run from source:

```json
{
  "mcpServers": {
    "observability": {
      "command": "npx",
      "args": ["tsx", "/path/to/lucid-observability-agent/src/server.ts"],
      "env": {
        "SENTRY_AUTH_TOKEN": "sntrys_...",
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SENTRY_AUTH_TOKEN` | Yes | Sentry internal integration token (scopes: `org:read`, `project:read`, `event:read`, `event:write`) |
| `SENTRY_ORG` | No | Sentry org slug (overrides config default) |
| `DATABASE_URL` | For metering tools | PostgreSQL connection string for OpenMeter outbox |
| `AGENT_CONFIG_PATH` | No | Path to custom config JSON (see [Configuration](#configuration)) |

## Tools (16)

### Sentry (6)

| Tool | Description |
|------|-------------|
| `sentry_list_issues` | List issues by project with Sentry search syntax |
| `sentry_get_issue` | Full detail: stack trace, tags, contexts, cross-links |
| `sentry_get_issue_events` | Event history with temporal pattern detection |
| `sentry_resolve_issue` | Resolve, ignore, or unresolve issues |
| `sentry_search_by_trace` | Find errors by OTel trace ID |
| `sentry_project_stats` | Error rate trends over time |

### Diagnosis (2)

| Tool | Description |
|------|-------------|
| `diagnose_issue` | Root cause analysis with configurable patterns |
| `cross_correlate` | Cross-service error correlation via trace_id/run_id |

### OpenMeter (4)

| Tool | Description |
|------|-------------|
| `openmeter_outbox_health` | Queue depth, dead letters, stuck leases |
| `openmeter_usage_by_org` | Per-org token/tool usage breakdown |
| `openmeter_dead_letter_retry` | Retry failed dead-letter events |
| `openmeter_usage_anomaly` | Spike/drop detection vs rolling baseline |

### Configuration (2)

| Tool | Description |
|------|-------------|
| `check_config_health` | Audit env vars for production readiness |
| `check_conventions` | Verify service uses standard conventions |

### Auto-Fix (2)

| Tool | Description |
|------|-------------|
| `suggest_alert_rules` | Generate Sentry alert configs from patterns |
| `generate_runbook` | Incident runbook for 10 error categories |

## Resources (3)

| URI | Description |
|-----|-------------|
| `{platform}://conventions` | Span names, attribute keys, rules |
| `{platform}://services` | Service topology and dependencies |
| `{platform}://sampling` | Sampling strategy reference |

## Prompts (3)

| Prompt | Description |
|--------|-------------|
| `triage-issue` | 6-step issue triage workflow |
| `production-readiness` | Full production audit scorecard |
| `incident-response` | 4-phase incident response protocol |

## Configuration

The agent ships with Lucid platform defaults (`config/lucid.json`). Override by setting `AGENT_CONFIG_PATH`:

```bash
AGENT_CONFIG_PATH=./my-config.json npx lucid-observability-agent
```

See `config/example.json` for a minimal config template. The config schema:

```typescript
interface AgentConfig {
  platform: { name: string; envVar: string }
  sentry: { defaultOrg: string; projects: string[] }
  services: Record<string, {
    repo: string; runtime: string; framework: string; sentryProject: string
  }>
  conventions: {
    spanNames: Record<string, string>
    attributeKeys: Record<string, { description: string; pii: boolean; highCardinality: boolean }>
    rules: string[]
  }
  dependencies: Record<string, string[]>
  traceFlow: string[]
  sampling: Record<string, number>
  runbooks: Record<string, RunbookPhase>
  diagnosisPatterns: DiagnosisPattern[]
  knownBugs: KnownBug[]
  metering: { outboxTable: string; deadLetterThreshold: number; queueDepthThreshold: number }
}
```

## Development

```bash
git clone https://github.com/raijin-labs/lucid-observability-agent
cd lucid-observability-agent
npm install
npm run typecheck   # Verify types
npm run dev         # Start with tsx (hot reload)
npm run build       # Build to dist/
```

## License

MIT
