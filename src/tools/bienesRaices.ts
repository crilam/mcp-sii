import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BienesRaicesScraper } from '../scrapers/bienesRaices';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { conErroresDeSesion, SesionNoIniciada } from '../erroresSesion';

const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export function registerSesionTools(
  server: McpServer,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  server.tool(
    'sii_iniciar_sesion',
    'Inicia sesión en el SII con el RUT y clave tributaria de una persona. Necesario antes de ' +
    'llamar cualquier otra tool con ese mismo RUT. Reintentar con el mismo RUT no abre una ' +
    'sesión nueva mientras la anterior siga vigente (dentro de 2 horas).',
    {
      rut: z.string().describe('RUT de la persona, con o sin puntos/guión'),
      clave: z.string().describe('Clave tributaria del SII de esa persona'),
    },
    async ({ rut, clave }) => {
      credenciales.guardar(rut, clave);
      try {
        await registro.ejecutar(rut, sesion => sesion.authenticateOnly());
      } catch (e) {
        credenciales.borrar(rut);
        const mensaje = e instanceof Error ? e.message : String(e);
        const error = mensaje.includes('El SII rechazó la autenticación')
          ? 'CREDENCIALES_INVALIDAS'
          : 'ERROR';
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, rut }) }] };
    }
  );

  server.tool(
    'sii_cerrar_sesion',
    'Cierra la sesión abierta en el SII para un RUT y olvida su credencial. El SII limita ' +
    'cuántas sesiones simultáneas puede tener un RUT y las bloquea al superarlas ' +
    '(error 01.01.190.500.720.27), así que conviene cerrarla al terminar.',
    {
      rut: z.string().describe('RUT de la persona cuya sesión se cierra'),
    },
    async ({ rut }) => {
      await registro.ejecutar(rut, sesion => sesion.logout());
      credenciales.borrar(rut);
      return {
        content: [{ type: 'text' as const, text: `Sesión cerrada en el SII para ${rut}.` }],
      };
    }
  );
}

export function registerBienesRaicesTools(
  server: McpServer,
  registro: RegistroSesiones<SessionManager>,
  browser: Browser
): void {
  server.tool(
    'sii_persona_list_bienes_raices',
    'Lista los bienes raíces (propiedades) del RUT persona autenticado en el SII, con comuna, ROL, dirección, destino, datos de inscripción, porcentaje de derechos y avalúo fiscal. Incluye un resumen con total de propiedades, solicitudes, notificaciones, afectación a sobretasa y beneficio de adulto mayor. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    {
      rut: z.string().describe(RUT_DESC),
    },
    async ({ rut }) => {
      const resultado = await conErroresDeSesion(() =>
        registro.ejecutar(rut, async sesion => {
          const scraper = new BienesRaicesScraper(browser, sesion);
          return scraper.listBienesRaices();
        })
      ).catch(e => {
        if (e instanceof SesionNoIniciada) {
          return { __error: 'SESION_NO_INICIADA' as const };
        }
        throw e;
      });

      if (resultado && typeof resultado === 'object' && '__error' in resultado) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: resultado.__error }) }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(resultado, null, 2),
        }],
      };
    }
  );
}
