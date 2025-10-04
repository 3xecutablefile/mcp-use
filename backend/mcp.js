import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { createJob, getJobById, getJobByCommand } from './store.js';
import { proxyToolCall } from './client.js';

const RunCommandInput = z.object({
  command: z.string().min(1, 'Command is required'),
});

const GetJobStatusBase = z.object({
  id: z.number().int().positive().optional(),
  command: z.string().min(1).optional(),
});

const GetJobStatusInput = GetJobStatusBase.refine(
  (value) => typeof value.id !== 'undefined' || typeof value.command !== 'undefined',
  {
    message: 'Provide either an id or command to query job status',
  },
);

const ProxyCallInput = z.object({
  server: z.string().min(1, 'server is required'),
  tool: z.string().min(1, 'tool is required'),
  args: z.record(z.any()).optional(),
  options: z.record(z.any()).optional(),
});

export function createMcpServer({ onJobQueued }) {
  const server = new McpServer(
    {
      name: 'Unified Job MCP Server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Use run_command to enqueue shell jobs for approval. Use get_job_status to inspect jobs. Use proxy_call to reach other MCP servers.',
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Queue command for approval',
      description: 'Queues a shell command for manual approval and later execution.',
      inputSchema: RunCommandInput.shape,
    },
    async (args) => {
      const parsed = await RunCommandInput.parseAsync(args);
      const job = await createJob(parsed.command);
      try {
        await Promise.resolve(onJobQueued?.(job));
      } catch (error) {
        console.error('Failed to enqueue job for approval:', error);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Queued: ${job.command} (job #${job.id})`,
          },
        ],
        structuredContent: job,
      };
    },
  );

  server.registerTool(
    'get_job_status',
    {
      title: 'Lookup job status',
      description: 'Retrieves status and output for a queued job by id or command.',
      inputSchema: GetJobStatusBase.shape,
    },
    async (args) => {
      const parsed = await GetJobStatusInput.parseAsync(args);
      const job =
        typeof parsed.id !== 'undefined'
          ? await getJobById(parsed.id)
          : await getJobByCommand(parsed.command);
      if (!job) {
        return {
          content: [
            {
              type: 'text',
              text: 'Job not found.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Job #${job.id} — status: ${job.status}`,
          },
        ],
        structuredContent: job,
      };
    },
  );

  server.registerTool(
    'proxy_call',
    {
      title: 'Call a tool on another MCP server',
      description:
        'Uses mcp-use to proxy a tool call to another MCP server via stdio or HTTP transports.',
      inputSchema: ProxyCallInput.shape,
    },
    async (args) => {
      const parsed = await ProxyCallInput.parseAsync(args);
      const result = await proxyToolCall({
        server: parsed.server,
        tool: parsed.tool,
        args: parsed.args ?? {},
        options: parsed.options ?? {},
      });
      return {
        content: result.content ?? [
          {
            type: 'text',
            text: `Proxy call to ${parsed.tool} on ${parsed.server} completed.`,
          },
        ],
        isError: Boolean(result.isError),
        structuredContent: {
          server: parsed.server,
          tool: parsed.tool,
          response: {
            ...result,
          },
        },
      };
    },
  );

  return server;
}
