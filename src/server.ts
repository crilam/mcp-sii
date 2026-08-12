import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Browser } from './browser';
import { SessionManager } from './session';
import { SiiHttpClient } from './http';
import { MipymeHttpScraper } from './scrapers/mipymeHttp';
import { BienesRaicesScraper } from './scrapers/bienesRaices';
import { BheScraper } from './scrapers/bhe';
import { RentaScraper } from './scrapers/renta';
import { RcvScraper } from './scrapers/rcv';
import { DteScraper } from './scrapers/dte';
import { registerMipymeTools } from './tools/mipyme';
import { registerDteTools } from './tools/dte';
import { registerBienesRaicesTools, registerSesionTools } from './tools/bienesRaices';
import { registerBheTools } from './tools/bhe';
import { registerRentaTools } from './tools/renta';
import { registerRcvTools } from './tools/rcv';
import { getConfig } from './env';

export function createServer(): McpServer {
  const config = getConfig();
  const browser = new Browser();
  const session = new SessionManager(config, browser);
  const bienesRaicesScraper = new BienesRaicesScraper(browser, session);
  // Mismo `session` que el resto de los scrapers: una sola sesión por proceso,
  // dos sesiones simultáneas contra el mismo RUT disparan el bloqueo del SII.
  const http = new SiiHttpClient(session);
  const bheScraper = new BheScraper(http, session);
  const rentaScraper = new RentaScraper(http, session);
  const rcvScraper = new RcvScraper(http, session);
  // Consultas DTE ya no usa el navegador: la empresa es un parámetro de cada
  // consulta, así que no hay estado compartido que aislar.
  const dteScraper = new DteScraper(http, session);
  // El portal mipyme entero —empresas, historial de emitidos y desde el
  // 2026-08-11 también la emisión— va por HTTP: son CGI legacy que responden
  // HTML. `MipymeScraper`, el scraper de navegador, se borró al migrar la
  // emisión: era su último método vivo.
  const mipymeHttpScraper = new MipymeHttpScraper(http, session);

  const server = new McpServer({
    name: 'mcp-sii',
    version: '0.1.0',
  });

  registerMipymeTools(server, mipymeHttpScraper);
  registerDteTools(server, dteScraper);
  registerBienesRaicesTools(server, bienesRaicesScraper);
  registerSesionTools(server, session);
  registerBheTools(server, bheScraper);
  registerRentaTools(server, rentaScraper);
  registerRcvTools(server, rcvScraper);

  return server;
}
