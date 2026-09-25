import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDispatcher } from './tool-dispatcher.js';

function createToolInputSchema(
  name: string,
  inputSchema: Record<string, unknown>,
): z.ZodType {
  // MCP SDK v2 cannot encode JSON Schema conditional keywords for the legacy
  // tool advertisement. Keep the canonical JSON definition unchanged, but
  // express this one conditional contract as a Zod union at registration time.
  if (name === 'bridge_recover_client') {
    const common = {
      confirm: z.literal(true),
      requestId: z.string().min(1).optional(),
      recoveryId: z.string().min(1).optional(),
      clientId: z.string().min(1).optional(),
      expectedDocumentUuid: z.string().min(1).optional(),
      expectedProjectUuid: z.string().min(1).optional(),
      expectedPageUuid: z.string().min(1).optional(),
      resolution: z.enum(['applied', 'cancelled']).optional(),
      hostRestartConfirmed: z.literal(true).optional(),
      readbackPath: z.enum([
        '/bridge/jlceda/context',
        '/bridge/jlceda/api/invoke',
        '/bridge/jlceda/schematic/read',
        '/bridge/jlceda/schematic/component-edit',
        '/bridge/jlceda/pcb/component-edit',
        '/bridge/jlceda/pcb/pour-manage',
        '/bridge/jlceda/schematic/review',
        '/bridge/jlceda/schematic/layout-check',
        '/bridge/jlceda/pcb/drc-check',
        '/bridge/jlceda/schematic/drc-check',
      ]).default('/bridge/jlceda/context'),
      readbackPayload: z.record(z.string(), z.unknown()).default({}),
    };
    const recover = z.object({ ...common, action: z.literal('recover').default('recover'), requestId: z.string().min(1) }).strict();
    const readback = z.object({
      ...common,
      action: z.literal('readback'),
      recoveryId: z.string().min(1),
      clientId: z.string().min(1),
    }).strict();
    const resolveImport = z.object({
      ...common,
      action: z.literal('resolve_import'),
      requestId: z.string().min(1),
      resolution: z.enum(['applied', 'cancelled']),
    }).strict();
    return z.union([recover, readback, resolveImport]);
  }
  const schema = z.fromJSONSchema(inputSchema as z.core.JSONSchema.JSONSchema);
  if (name === 'pcb_component_edit' || name === 'schematic_component_edit' || name === 'pcb_pour_manage') {
    // z.fromJSONSchema currently omits minProperties. Preserve the advertised
    // contract when the call reaches the MCP parser.
    return schema.superRefine((value, context) => {
      if (typeof value === 'object' && value !== null && 'action' in value && value.action === 'modify'
        && 'property' in value && typeof value.property === 'object' && value.property !== null
        && Object.keys(value.property).length === 0) {
        context.addIssue({ code: 'custom', path: ['property'], message: 'property must contain at least one field' });
      }
    });
  }
  return schema;
}

export function createMcpServer(
  toolDispatcher: ToolDispatcher,
  serverVersion: string,
  instructions: string,
): McpServer {
  const server = new McpServer(
    {
      name: 'jlceda-mcp-server',
      title: 'JLCEDA MCP Community',
      version: serverVersion,
    },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );

  for (const definition of toolDispatcher.getToolDefinitions()) {
    const inputSchema = createToolInputSchema(definition.name, definition.inputSchema);
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema,
      },
      async (args): Promise<CallToolResult> => {
        return await toolDispatcher.dispatch({
          name: definition.name,
          arguments: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
        });
      },
    );
  }

  return server;
}
