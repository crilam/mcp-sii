import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Browser } from './browser';
import { SessionManager } from './session';
import { SiiHttpClient } from './http';
import { MipymeScraper } from './scrapers/mipyme';
import { BienesRaicesScraper } from './scrapers/bienesRaices';
import { BheScraper } from './scrapers/bhe';
import { registerMipymeTools } from './tools/mipyme';
import { registerDteTools } from './tools/dte';
import { registerBienesRaicesTools, registerSesionTools } from './tools/bienesRaices';
import { registerBheTools } from './tools/bhe';
import { getConfig } from './env';

export function createServer(): McpServer {
  const config = getConfig();
  const browser = new Browser();
  const session = new SessionManager(config, browser);
  const scraper = new MipymeScraper(browser, session);
  const bienesRaicesScraper = new BienesRaicesScraper(browser, session);
  // Mismo `session` que el resto de los scrapers: una sola sesión por proceso,
  // dos sesiones simultáneas contra el mismo RUT disparan el bloqueo del SII.
  const http = new SiiHttpClient(session);
  const bheScraper = new BheScraper(http, session);

  const server = new McpServer({
    name: 'mcp-sii',
    version: '0.1.0',
  });

  registerMipymeTools(server, scraper);
  registerDteTools(server, scraper);
  registerBienesRaicesTools(server, bienesRaicesScraper);
  registerSesionTools(server, session);
  registerBheTools(server, bheScraper);

  return server;
}
