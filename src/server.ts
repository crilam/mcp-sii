import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Browser } from './browser';
import { SessionManager } from './session';
import { MipymeScraper } from './scrapers/mipyme';
import { registerMipymeTools } from './tools/mipyme';
import { registerDteTools } from './tools/dte';
import { getConfig } from './env';

export function createServer(): McpServer {
  const config = getConfig();
  const browser = new Browser();
  const session = new SessionManager(config, browser);
  const scraper = new MipymeScraper(browser, session);

  const server = new McpServer({
    name: 'mcp-sii',
    version: '0.1.0',
  });

  registerMipymeTools(server, scraper);
  registerDteTools(server, scraper);

  return server;
}
