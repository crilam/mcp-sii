import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegistroSesiones } from '../registroSesiones';
import { SessionManager } from '../session';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/rcvEscritura';
import { schemaEventosAcuse, schemaAcusar } from '../core/schemas/rcvEscritura';

export function registerRcvEscrituraTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_rcv_eventos_acuse',
    'Catálogo de los eventos de acuse de recibo válidos del RCV: código (dedCodEvento) y descripción. Hoy el SII expone ERM (Acuse de Recibo de Mercaderías y Servicios, Ley 19.983) y ERG (Acuse de Recibo de Mercaderías en Guía de Despacho del mes anterior). Es lectura; sirve para saber qué `evento` pasarle a sii_rcv_acusar.',
    schemaEventosAcuse,
    async ({ rut }) => envolverParaMcp(() => core.eventosAcuse(registro, rut))
  );

  server.tool(
    'sii_rcv_acusar',
    'ACUSA RECIBO de uno o más documentos en el RCV. ES UNA ESCRITURA: con confirmar=true es un ACTO REAL E IRREVERSIBLE con efectos legales — bajo la Ley 19.983 el acuse de recibo habilita la cesión del crédito del documento. ' +
    'Por defecto (confirmar ausente o false) NO escribe: SIMULA y devuelve qué se acusaría, validando el evento contra el catálogo del SII. Para cursar el acuse de verdad hay que pasar confirmar=true de forma explícita. ' +
    'Antes de usarla conviene mostrarle al usuario qué documentos y qué evento se van a acusar y pedir su confirmación; no pasar confirmar=true por iniciativa propia. ' +
    'El `evento` sale de sii_rcv_eventos_acuse (ERM o ERG). Cada documento se identifica por rut_emisor, tipo_doc y folio. ' +
    'Hay una red anti-doble-click: el mismo acuse repetido en menos de un minuto se rechaza en vez de duplicarse. La traza de auditoría del acto vive sólo en el camino REST (POST /v1/rcv/acuse); esta tool no deja registro en esa tabla.',
    schemaAcusar,
    async ({ rut, documentos, evento, confirmar }) =>
      envolverParaMcp(() => core.acusar(
        registro, rut,
        documentos.map(d => ({ rutEmisor: d.rut_emisor, tipoDoc: d.tipo_doc, folio: d.folio })),
        evento, confirmar ?? false))
  );
}
