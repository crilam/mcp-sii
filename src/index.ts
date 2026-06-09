import 'dotenv/config';
import { validateEnv } from './env';
import { createServer } from './server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function start(): Promise<void> {
  validateEnv();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
