#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createObservabilityServer } from './mcp.js';

const server = createObservabilityServer();
const transport = new StdioServerTransport();
await server.connect(transport);
