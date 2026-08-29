import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMipymeTools } from './tools/mipyme';
import { registerDteTools } from './tools/dte';
import { registerBienesRaicesTools, registerSesionTools } from './tools/bienesRaices';
import { registerBheTools } from './tools/bhe';
import { registerRentaTools } from './tools/renta';
import { registerRcvTools } from './tools/rcv';
import { registerIndicadoresTools } from './tools/indicadores';
import { registerMisiiTools } from './tools/misii';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRegistroSesionesSii } from './registroSesionesSii';

export function createServer(): McpServer {
  // Credenciales por RUT, cargadas en tiempo de ejecución vía
  // sii_iniciar_sesion (no de env): nunca se persisten a disco.
  const credenciales = new ProveedorCredencialesRuntime();
  // Un SessionManager por RUT, creado a demanda por el registro, cada uno con su
  // propio contexto de navegador. NO se comparte un Browser entre RUTs: el
  // contexto guarda las cookies de sesión del SII, o sea estado por credencial
  // (ver el comentario en registroSesionesSii.ts).
  const registro = crearRegistroSesionesSii(credenciales);

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
  registerMisiiTools(server, registro);
  // Sin `registro`: los indicadores son páginas públicas, no hay sesión.
  registerIndicadoresTools(server);

  return server;
}
