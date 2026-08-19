import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Browser } from './browser';
import { registerMipymeTools } from './tools/mipyme';
import { registerDteTools } from './tools/dte';
import { registerBienesRaicesTools, registerSesionTools } from './tools/bienesRaices';
import { registerBheTools } from './tools/bhe';
import { registerRentaTools } from './tools/renta';
import { registerRcvTools } from './tools/rcv';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRegistroSesionesSii } from './registroSesionesSii';

export function createServer(): McpServer {
  const browser = new Browser();
  // Credenciales por RUT, cargadas en tiempo de ejecución vía
  // sii_iniciar_sesion (no de env): nunca se persisten a disco.
  const credenciales = new ProveedorCredencialesRuntime();
  // Un SessionManager por RUT, creado a demanda por el registro. El `browser`
  // se comparte entre todas las sesiones: es el proceso de agent-browser (un
  // daemon), no estado por credencial.
  const registro = crearRegistroSesionesSii(credenciales, browser);

  const server = new McpServer({
    name: 'mcp-sii',
    version: '0.1.0',
  });

  registerMipymeTools(server, registro);
  registerDteTools(server, registro);
  registerBienesRaicesTools(server, registro);
  registerSesionTools(server, registro, credenciales);
  registerBheTools(server, registro);
  registerRentaTools(server, registro);
  registerRcvTools(server, registro);

  return server;
}
