# Design: Restructure as Dual MCP + OpenClaw Plugin

**Date:** 2026-02-23
**Status:** Approved
**Version:** 3.0.0

## Context

The lucid-observability-agent is currently a pure MCP server (v2.1.0) with a separate `service.ts` for autonomous monitoring (webhooks + scheduler). This design restructures the repo to follow the **Lucid-Veille dual entry point pattern**: a single codebase that works as both an MCP server (for Claude Code) and an OpenClaw tool plugin (for autonomous AI-driven monitoring via heartbeat).

## Decision: Heartbeat-Only Autonomy

All hardcoded autonomous logic (`auto-resolve.ts`, `webhook.ts`, `scheduler.ts`, `service.ts`) is removed. Autonomous behavior is delegated entirely to OpenClaw's heartbeat system + LLM reasoning using our tools.

## Architecture

```
npm package: lucid-observability-agent
├── Export "."     → OpenClaw plugin (register function)
├── Export "./mcp" → MCP server (createServer function)
├── Export "./core"→ Core library (tools, helpers, types)
└── Bin "lucid-obs-agent" → CLI (MCP over stdio)
```

```
src/
├── index.ts              # Re-export OpenClaw entry
├── mcp.ts                # MCP server: McpServer + Zod adapter
├── openclaw.ts           # OpenClaw plugin: register(api) + TypeBox adapter
├── bin.ts                # CLI: MCP over stdio
├── adapters/
│   ├── zod-schema.ts     # ToolParamDef → Zod
│   └── typebox-schema.ts # ToolParamDef → TypeBox
└── core/
    ├── index.ts           # Barrel export
    ├── plugin-id.ts       # PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION
    ├── config/
    │   ├── schema.ts      # TypeBox config schema
    │   ├── loader.ts      # loadConfig() — env + file + defaults merge
    │   └── defaults.ts    # DEFAULT_CONFIG
    ├── types/
    │   └── config.ts      # AgentConfig interface
    ├── tools/
    │   ├── types.ts       # ToolDefinition, ToolParamDef
    │   ├── index.ts       # createAllTools(deps) → ToolDefinition[]
    │   ├── sentry.ts      # 6 tools
    │   ├── diagnosis.ts   # 2 tools (buildDiagnosis + cross_correlate)
    │   ├── openmeter.ts   # 4 tools
    │   ├── config-health.ts # 2 tools
    │   └── autofix.ts     # 2 tools
    ├── commands/
    │   ├── index.ts       # registerAllCommands(api, deps)
    │   ├── obs-status.ts  # /obs-status
    │   └── obs-check.ts   # /obs-check
    ├── helpers/
    │   ├── sentry.ts      # sentryFetch(), resolveIssue()
    │   ├── postgres.ts    # getPgPool()
    │   ├── response.ts    # ok(), err(), json()
    │   └── temporal.ts    # detectTemporalPattern(), extractStacktrace/Breadcrumbs
    └── resources/
        ├── conventions.ts
        ├── services.ts
        └── sampling.ts
```

## Tool System

All 16 tools defined with generic `ToolParamDef` (framework-agnostic):

```typescript
interface ToolDefinition<T = any> {
  name: string
  description: string
  params: Record<string, ToolParamDef>
  execute: (params: T) => Promise<string>
}

type ToolParamDef = {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array'
  required?: boolean
  description?: string
  default?: unknown
  values?: string[]
  min?: number; max?: number
  properties?: Record<string, ToolParamDef>
  items?: ToolParamDef
}
```

**Factory**: `createAllTools(deps: ToolDependencies)` returns all 16 tools. `deps` carries config, sentry fetch fn, DB pool — dependency injection.

**Adapters**: `toZodSchema()` for MCP, `toTypeBoxSchema()` for OpenClaw.

## OpenClaw Integration

**Plugin manifest** (`openclaw.plugin.json`): Declares config schema (sentryAuthToken, sentryOrg, databaseUrl, configPath) with UI hints and sensitivity flags.

**Commands**:
- `/obs-status` — config health + outbox health summary
- `/obs-check` — full health check suite on demand

**Skill** (`skills/lucid-observability/SKILL.md`): Contains the 3 prompt workflows (triage-issue, production-readiness, incident-response) as structured skill instructions.

**Heartbeat integration**: Users configure `HEARTBEAT.md` with observability checks. The OpenClaw agent calls our tools on each heartbeat cycle to monitor Sentry, outbox health, error spikes, etc.

## MCP Integration

Same as before: 16 tools, 3 resources, 3 prompts over stdio. `npx lucid-obs-agent` runs MCP server. Zero breaking changes for Claude Code users.

**Resources** stay MCP-only. Data functions live in `src/core/resources/`, wrapped by `mcp.ts`.

**Prompts** dual-purposed: registered as MCP prompts AND embedded in SKILL.md.

## Files Deleted

| File | Reason |
|------|--------|
| `src/auto-resolve.ts` | LLM reasoning replaces hardcoded decisions |
| `src/webhook.ts` | Heartbeat polling replaces webhook receiver |
| `src/scheduler.ts` | Heartbeat replaces cron scheduler |
| `src/service.ts` | No separate service process needed |

## Dependencies

**Added**: `@sinclair/typebox` (OpenClaw adapter), `tsup` (build tool)
**Kept**: `@modelcontextprotocol/sdk`, `pg`, `zod`
**Removed**: none

## Version

2.1.0 → 3.0.0 (structural change, new package exports)
