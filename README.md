# Lucid Observability Agent

MCP server **and** OpenClaw plugin for monitoring, diagnosing, and auto-correcting observability issues across platform services. Connects to **Sentry** for error tracking, **PostgreSQL** for OpenMeter billing pipeline health, and ships with AI-powered diagnosis, incident runbooks, and cross-service correlation.

Unlike the official Sentry MCP server (which is a pure API wrapper), this agent adds:

- **Root cause analysis** --- pattern matching against error titles, stack traces, and platform-specific knowledge
- **Cross-service correlation** --- traces errors across multiple services via `trace_id` / `run_id`
- **Billing pipeline monitoring** --- outbox health, dead letter recovery, usage anomaly detection
- **Incident runbooks** --- 10 error categories with 5-phase playbooks (triage -> diagnose -> mitigate -> resolve -> postmortem)
- **Alert rule generation** --- suggests Sentry alert rules based on actual error patterns
- **Production readiness auditing** --- validates env vars, conventions, and configuration

> **v3.0.0** --- Dual entry point architecture: works as both an MCP server (Claude Code / Claude Desktop) and an OpenClaw plugin with slash commands and heartbeat support.

## Quick Start

### As MCP Server (Claude Code)

Install from npm and run directly:

```bash
npx lucid-obs-agent
```

Or add to your MCP config (`~/.claude.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "observability": {
      "command": "npx",
      "args": ["lucid-obs-agent"],
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
      "args": ["tsx", "/path/to/lucid-observability-agent/src/bin.ts"],
      "env": {
        "SENTRY_AUTH_TOKEN": "sntrys_...",
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

### As OpenClaw Plugin

1. Install the package:

```bash
npm install lucid-observability-agent
```

2. Add to your `openclaw.json`:

```json
{
  "plugins": [
    {
      "id": "lucid-observability",
      "package": "lucid-observability-agent",
      "config": {
        "sentryAuthToken": "sntrys_...",
        "sentryOrg": "your-org",
        "databaseUrl": "postgresql://..."
      }
    }
  ]
}
```

The plugin registers all 16 tools, 3 resources, 3 prompts, and 2 slash commands automatically.

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

These prompts are also documented with full workflows in [`SKILL.md`](skills/lucid-observability/SKILL.md).

## Commands (OpenClaw)

When running as an OpenClaw plugin, two slash commands are available:

| Command | Description |
|---------|-------------|
| `/obs-status` | Show observability agent status --- config, services, connections |
| `/obs-check` | Run observability health checks --- config audit + outbox health |

## OpenClaw Heartbeat

OpenClaw supports autonomous monitoring via a `HEARTBEAT.md` file. The agent runs the checks on a schedule and reports findings without manual prompting.

Add a `HEARTBEAT.md` to your project root (or reference the checklist in `SKILL.md`):

```markdown
## Observability Checks
- Run `openmeter_outbox_health` — alert if dead letters > 0 or stuck leases
- Run `sentry_list_issues` sorted by freq — flag issues with count > 100
- Run `check_config_health` — warn if any critical checks failing
- If issues found, run `diagnose_issue` and suggest resolution
```

The heartbeat runs these checks periodically and surfaces warnings or critical findings through OpenClaw's notification system.

## Configuration

The agent ships with Lucid platform defaults (`config/lucid.json`). Override by setting `AGENT_CONFIG_PATH`:

```bash
AGENT_CONFIG_PATH=./my-config.json npx lucid-obs-agent
```

When using the OpenClaw plugin, pass the config path via plugin config:

```json
{
  "configPath": "./config/my-config.json"
}
```

See `config/example.json` for a minimal config template.

## Development

```bash
git clone https://github.com/daishizenSensei/lucid-observability-agent
cd lucid-observability-agent
npm install
npm run typecheck   # Verify types
npm run dev         # Start with tsx (hot reload)
npm run build       # Build with tsup to dist/
npm run start       # Run built output
```

### Project Structure

```
src/
  bin.ts            # CLI entry point (MCP stdio server)
  index.ts          # Package re-export (core + mcp + openclaw)
  mcp.ts            # MCP server setup (tools, resources, prompts)
  openclaw.ts       # OpenClaw plugin entry (tools, commands, skills)
  core/
    tools/          # 16 tool definitions (ToolParamDef format)
    resources/      # 3 resource data providers
    commands/       # /obs-status, /obs-check handlers
    config/         # Config loading and defaults
    helpers/        # Sentry API, DB client, shared utils
    types/          # TypeScript type definitions
```

## License

MIT
