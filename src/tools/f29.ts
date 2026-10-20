import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegistroSesiones } from '../registroSesiones';
import { SessionManager } from '../session';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/f29';
import { schemaEstadoF29, schemaVerificarF29 } from '../core/schemas/f29';
import { verificarF29, rangoPeriodos } from '../f29Verificacion/recolector';

export function registerF29Tools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_f29_estado_declaracion',
    'Estado de la declaración de Formulario 29 (IVA mensual) de un período (AAAAMM): folio, estado (Vigente, Anulada...), si tiene observaciones, fecha de presentación y moneda. Un período sin declaración vigente responde NO_ENCONTRADO. El PDF del formulario compacto se pide aparte por REST (/v1/f29/formulario-compacto): un PDF en base64 satura el contexto del modelo.',
    schemaEstadoF29,
    async ({ rut, periodo }) => envolverParaMcp(() => core.estadoDeclaracion(registro, rut, periodo))
  );

  server.tool(
    'sii_f29_verificar',
    'Revisa el F29 (SÓLO LECTURA): si el período vencido está declarado y si el último F29 declarado (o el período o rango pedidos) cuadra con el Registro de Compras y Ventas. Cruza códigos 519/520/525, 527/528, 535, 039/736/596, 502/503, 509/510, 513, 142 y 020 contra el RCV, revisa la aritmética (538, 537, 089/755, 595, 547), la condición IVA (afecta, exenta, mixta) y montos atípicos. Detecta el error de la propuesta del SII que omite del 520 el IVA de las facturas de compra con retención total (tipo 46). Con `propuesta` cruza también la propuesta del SII de ese período. Devuelve hallazgos por código con declarado, esperado, diferencia, severidad, explicación y fuente, y el crédito omitido y la retención pagada de más.',
    schemaVerificarF29,
    async ({ rut, periodo, desde, hasta, propuesta, dia_vencimiento }) => envolverParaMcp(async () => {
      let periodos: number[] = periodo ? [periodo] : [];
      if (desde || hasta) {
        if (!desde || !hasta) throw new Error('desde y hasta van juntos.');
        periodos = rangoPeriodos(desde, hasta);
        if (periodos.length === 0 || periodos.length > 12) throw new Error('El rango debe ir de desde a hasta y ser de 12 meses como máximo.');
      }
      return verificarF29(registro, { rut, periodos, propuesta: propuesta ?? null, diaVencimiento: dia_vencimiento });
    })
  );
}
