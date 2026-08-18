import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RentaScraper } from '../scrapers/renta';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { conErroresDeSesion, SesionNoIniciada } from '../erroresSesion';

const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

const anio = z.number().int().min(2000).max(2100)
  .describe('Año tributario a consultar (el año en que se declaró, no el año de los ingresos)');

async function conScraper<R>(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  fn: (scraper: RentaScraper) => Promise<R>
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const resultado = await conErroresDeSesion(() =>
    registro.ejecutar(rut, async sesion => {
      const scraper = new RentaScraper(new SiiHttpClient(sesion), sesion);
      return fn(scraper);
    })
  ).catch(e => {
    if (e instanceof SesionNoIniciada) {
      return { __error: 'SESION_NO_INICIADA' as const };
    }
    throw e;
  });

  if (resultado && typeof resultado === 'object' && '__error' in resultado) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: resultado.__error }) }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
  };
}

export function registerRentaTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_renta_estado_declaracion',
    'Estado de la declaración de renta (Formulario 22) del RUT persona autenticado para un año tributario. ' +
    'Devuelve las declaraciones del año (folio, si es la vigente, código de estado, domicilio, fecha de ' +
    'vencimiento y remanente solicitado/devuelto) junto con las glosas: el texto del SII que explica el ' +
    'estado —si hubo devolución y por cuánto, o qué inconsistencia se detectó—, que es lo más útil de la ' +
    'respuesta. Si el año no tiene declaración, responde sinDatos=true con las listas vacías: es un vacío ' +
    'legítimo, no un error. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    { rut: z.string().describe(RUT_DESC), anio },
    async ({ rut, anio }: { rut: string; anio: number }) =>
      conScraper(registro, rut, scraper => scraper.estadoDeclaracion(anio))
  );

  server.tool(
    'sii_renta_get_f22',
    'Formulario 22 completo de un año tributario del RUT persona autenticado: la lista de todos los códigos ' +
    'del formulario con su valor y su glosa. Si se omite el folio, se resuelve solo consultando la ' +
    'declaración vigente del año (una consulta extra al SII); si ese año no tiene una declaración vigente, ' +
    'falla pidiendo el folio explícito en vez de devolver un formulario vacío. ' +
    'No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    {
      rut: z.string().describe(RUT_DESC),
      anio,
      folio: z.number().int().positive().optional()
        .describe('Folio de la declaración. Si se omite, se usa el de la declaración vigente del año.'),
    },
    async ({ rut, anio, folio }: { rut: string; anio: number; folio?: number }) =>
      conScraper(registro, rut, scraper => scraper.f22Completo(anio, folio))
  );
}
