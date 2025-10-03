import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { MCPClient } from 'mcp-use';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultConfigPath = process.env.MCP_PROXY_CONFIG
  ? path.resolve(process.cwd(), process.env.MCP_PROXY_CONFIG)
  : path.resolve(__dirname, '../proxy.config.json');

const initialConfig = loadInitialConfig(defaultConfigPath);
const client = new MCPClient(initialConfig);
const dynamicServerMap = new Map();

function loadInitialConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch (error) {
    console.error('Failed to load MCP proxy config:', error);
  }
  return { mcpServers: {} };
}

function saveConfigIfNeeded() {
  if (!process.env.MCP_PROXY_CONFIG_PERSIST) {
    return;
  }
  try {
    const dir = path.dirname(defaultConfigPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(defaultConfigPath, JSON.stringify(client.getConfig(), null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to persist MCP proxy config:', error);
  }
}

function tokenizeCommand(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === quote || next === '\\') {
          current += next;
          i += 1;
          continue;
        }
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      if (current) {
        tokens.push(current);
        current = '';
      }
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  if (quote) {
    throw new Error('Unterminated quoted string in stdio server specification');
  }
  return tokens;
}

function resolveServer(serverSpec) {
  const configuredServers = client.getConfig().mcpServers ?? {};
  if (configuredServers[serverSpec]) {
    return { name: serverSpec, config: configuredServers[serverSpec] };
  }
  if (dynamicServerMap.has(serverSpec)) {
    return dynamicServerMap.get(serverSpec);
  }
  let name;
  let config;
  if (/^https?:\/\//i.test(serverSpec)) {
    name = `http-${crypto.createHash('sha1').update(serverSpec).digest('hex').slice(0, 8)}`;
    config = { url: serverSpec };
  } else if (serverSpec.startsWith('stdio:')) {
    const remainder = serverSpec.slice('stdio:'.length).trim();
    if (!remainder) {
      throw new Error('stdio server specification must include a command');
    }
    const [command, ...args] = tokenizeCommand(remainder);
    if (!command) {
      throw new Error('Unable to parse command for stdio server specification');
    }
    name = `stdio-${crypto.createHash('sha1').update(serverSpec).digest('hex').slice(0, 8)}`;
    config = { command, args };
  } else {
    throw new Error(`Unknown server specification '${serverSpec}'. Provide a configured name, http(s) URL, or stdio: command.`);
  }
  client.addServer(name, config);
  const resolved = { name, config };
  dynamicServerMap.set(serverSpec, resolved);
  saveConfigIfNeeded();
  return resolved;
}

async function ensureSession(name) {
  let session = client.getSession(name);
  if (!session) {
    session = await client.createSession(name, true);
    return session;
  }
  if (!session.isConnected) {
    await session.initialize();
  }
  return session;
}

export async function proxyToolCall({ server, tool, args = {}, options = {} }) {
  if (!server) {
    throw new Error('proxy_call requires a "server" parameter');
  }
  if (!tool) {
    throw new Error('proxy_call requires a "tool" parameter');
  }
  const { name } = resolveServer(server);
  const session = await ensureSession(name);
  const connector = session.connector;
  if (!connector) {
    throw new Error(`No connector available for server '${name}'`);
  }
  await session.initialize();
  const result = await connector.callTool(tool, args, options);
  return result;
}

export async function shutdownProxy() {
  await client.closeAllSessions();
}
