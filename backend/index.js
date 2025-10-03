#!/usr/bin/env node
import process from 'process';
import fs from 'fs';
import readline from 'readline';
import { EventEmitter, once } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { createMcpServer } from './mcp.js';
import { listPendingJobs, updateJob, getJobById, closeStore } from './store.js';
import { shutdownProxy } from './client.js';

const execAsync = promisify(exec);
const jobEvents = new EventEmitter();
const pendingQueue = [];
const pendingSet = new Set();
let shuttingDown = false;
let serverInstance;

const EXEC_TIMEOUT_MS = Number.parseInt(process.env.JOB_TIMEOUT_MS ?? '300000', 10);
const EXEC_MAX_BUFFER = Number.parseInt(process.env.JOB_MAX_BUFFER ?? String(10 * 1024 * 1024), 10);

function queueJob(job) {
  if (!job || job.status !== 'pending') {
    return;
  }
  if (pendingSet.has(job.id)) {
    return;
  }
  pendingSet.add(job.id);
  pendingQueue.push(job);
  jobEvents.emit('job');
}

async function primePendingJobs() {
  try {
    const jobs = await listPendingJobs();
    for (const job of jobs) {
      queueJob(job);
    }
  } catch (error) {
    console.error('Failed to load pending jobs:', error);
  }
}

function createApprovalInterface() {
  try {
    const input = fs.createReadStream('/dev/tty');
    const output = fs.createWriteStream('/dev/tty');
    const rl = readline.createInterface({ input, output, terminal: true });
    const ask = (prompt) =>
      new Promise((resolve) => {
        rl.question(prompt, (answer) => {
          resolve(answer);
        });
      });
    return {
      async question(prompt) {
        return ask(prompt);
      },
      close() {
        rl.close();
        input.close?.();
        output.end?.();
      },
    };
  } catch (error) {
    console.error('Interactive approval unavailable; jobs will be auto-rejected.', error);
    return null;
  }
}

const approvalInterface = createApprovalInterface();

async function nextPendingJob() {
  while (!shuttingDown) {
    if (pendingQueue.length) {
      const job = pendingQueue.shift();
      pendingSet.delete(job.id);
      const latest = await getJobById(job.id);
      if (!latest || latest.status !== 'pending') {
        continue;
      }
      return latest;
    }
    await primePendingJobs();
    if (pendingQueue.length) {
      continue;
    }
    try {
      await once(jobEvents, 'job');
    } catch (error) {
      console.error('Error waiting for next job:', error);
      return null;
    }
  }
  return null;
}

async function promptApproval(job) {
  if (!approvalInterface) {
    console.error(`Auto-rejecting job #${job.id} due to unavailable approval interface.`);
    return 'n';
  }
  while (!shuttingDown) {
    const answer = await approvalInterface.question(`Job #${job.id}: ${job.command} — Approve? (y/n): `);
    if (typeof answer !== 'string') {
      continue;
    }
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes') {
      return 'y';
    }
    if (normalized === 'n' || normalized === 'no') {
      return 'n';
    }
    console.error('Please respond with "y" or "n".');
  }
  return 'n';
}

async function runJob(job) {
  const startedAt = new Date().toISOString();
  await updateJob(job.id, { status: 'running', startedAt });
  try {
    const { stdout, stderr } = await execAsync(job.command, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      shell: process.env.SHELL ?? '/bin/bash',
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    await updateJob(job.id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      output: output || null,
      error: null,
    });
    console.error(`Job #${job.id} completed successfully.`);
  } catch (error) {
    const stdout = error?.stdout ?? '';
    const stderr = error?.stderr ?? '';
    const output = [stdout, stderr].filter(Boolean).join('\n');
    await updateJob(job.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      output: output || null,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`Job #${job.id} failed:`, error);
  }
}

async function rejectJob(job) {
  await updateJob(job.id, {
    status: 'rejected',
    finishedAt: new Date().toISOString(),
    error: 'Rejected by operator',
  });
  console.error(`Job #${job.id} was rejected.`);
}

async function approvalLoop() {
  await primePendingJobs();
  while (!shuttingDown) {
    const job = await nextPendingJob();
    if (!job) {
      if (shuttingDown) {
        break;
      }
      continue;
    }
    const decision = await promptApproval(job);
    if (decision === 'y') {
      await runJob(job);
    } else {
      await rejectJob(job);
    }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error('Shutting down MCP server...');
  try {
    approvalInterface?.close();
  } catch (error) {
    console.error('Error closing approval interface:', error);
  }
  try {
    await shutdownProxy();
  } catch (error) {
    console.error('Error shutting down MCP proxy:', error);
  }
  try {
    await serverInstance?.close();
  } catch (error) {
    console.error('Error closing MCP server:', error);
  }
  try {
    await closeStore();
  } catch (error) {
    console.error('Error closing job store:', error);
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  shutdown(0).catch((error) => {
    console.error('Failed to shutdown cleanly:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown(0).catch((error) => {
    console.error('Failed to shutdown cleanly:', error);
    process.exit(1);
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown(1).catch(() => process.exit(1));
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  shutdown(1).catch(() => process.exit(1));
});

async function main() {
  const server = createMcpServer({
    onJobQueued: queueJob,
  });
  serverInstance = server;
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Unified MCP server is running over stdio.');
  approvalLoop().catch((error) => {
    console.error('Approval loop error:', error);
  });
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  shutdown(1).catch(() => process.exit(1));
});
