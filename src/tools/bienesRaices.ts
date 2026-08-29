import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { clasificarErrorCredenciales, envolverParaMcp } from '../erroresSesion';
import * as core from '../core/bienesRaices';
import { schemaListBienesRaices, schemaSoloRut, schemaRol } from '../core/schemas/bienesRaices';

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
        // Y se desaloja la sesión fallida. Sin esto quedaba cacheada con la
        // config vieja —`crear` captura la credencial al construir la sesión—,
        // así que reintentar con la clave corregida reusaba la instancia con la
        // clave mala y fallaba para siempre, hasta un `sii_cerrar_sesion`. Y
        // desde que cada sesión tiene su propio contexto de navegador, cada
        // intento fallido dejaba además un proceso y un perfil en disco que
        // nadie cerraba.
        //
        // Se cierra sin logout: no hay sesión que cerrar del lado del SII
        // justamente porque la autenticación falló.
        await registro.cerrarYOlvidar(rut, async () => {});
        const error = clasificarErrorCredenciales(e);
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
      // logout + desalojo como UNA unidad dentro de la cola del RUT. Antes esto
      // era `ejecutar(logout)` y nada más: la credencial se olvidaba pero el
      // proceso del navegador y su perfil en disco quedaban vivos para siempre.
      // Y hacerlo en dos pasos (ejecutar + olvidar) tampoco sirve: el desalojo
      // cierra el navegador y borra su perfil, así que fuera de la cola puede
      // arrancarle el contexto a otra operación del mismo RUT que esté en vuelo.
      await registro.cerrarYOlvidar(rut, sesion => sesion.logout());
      credenciales.borrar(rut);
      return {
        content: [{ type: 'text' as const, text: `Sesión cerrada en el SII para ${rut}.` }],
      };
    }
  );
}

export function registerBienesRaicesTools(
  server: McpServer,
  registro: RegistroSesiones<SessionManager>
): void {
  server.tool(
    'sii_persona_list_bienes_raices',
    'Lista los bienes raíces (propiedades) del RUT persona autenticado en el SII, con comuna, ROL, dirección, destino, datos de inscripción, porcentaje de derechos y avalúo fiscal. Incluye un resumen con total de propiedades, solicitudes, notificaciones, afectación a sobretasa y beneficio de adulto mayor. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaListBienesRaices,
    async ({ rut }) => envolverParaMcp(() => core.listBienesRaices(registro, rut))
  );

  server.tool(
    'sii_bienes_raices_comunas',
    'Lista las comunas del catastro de bienes raíces del SII con su código. El código es el que ' +
    'piden sii_bienes_raices_consultar_rol y sii_bienes_raices_multipropietarios en `comuna`: el ' +
    'rol de una propiedad ("00632-00244") identifica manzana y predio, pero la comuna va aparte.',
    schemaSoloRut,
    async ({ rut }) => envolverParaMcp(() => core.comunas(registro, rut))
  );

  server.tool(
    'sii_bienes_raices_consultar_rol',
    'Consulta un bien raíz CUALQUIERA por su rol (comuna, manzana, predio): comuna, rol, dirección, ' +
    'destino, avalúo fiscal vigente y contribuciones. Es la consulta que el portal ofrece a ' +
    'terceros, así que no exige ser el propietario. Manzana y predio son las dos partes del rol ' +
    '("00632-00244" → manzana 632, predio 244). Un rol inexistente responde NO_ENCONTRADO.',
    schemaRol,
    async ({ rut, comuna, manzana, predio }) =>
      envolverParaMcp(() => core.consultarPorRol(registro, rut, { comuna, manzana, predio }))
  );

  server.tool(
    'sii_bienes_raices_multipropietarios',
    'Copropietarios de un bien raíz por rol: RUT, nombre, porcentaje de derechos y datos de la ' +
    'inscripción (fojas, número, año, fecha). Sirve para saber quiénes comparten una propiedad ' +
    'antes de pedir un certificado con propietarios.',
    schemaRol,
    async ({ rut, comuna, manzana, predio }) =>
      envolverParaMcp(() => core.multipropietarios(registro, rut, { comuna, manzana, predio }))
  );

  server.tool(
    'sii_bienes_raices_solicitudes',
    'Historial de solicitudes de documentos de bienes raíces del contribuyente (certificados de ' +
    'avalúo, de antecedentes, etc.): fecha, vigencia, estado, tipo, folio, código de verificación ' +
    'y la url para bajar el PDF. El PDF se baja por REST (/v1/bienes-raices/documento), no por MCP: ' +
    'un PDF en base64 satura el contexto sin que el modelo pueda hacer nada con él.',
    schemaSoloRut,
    async ({ rut }) => envolverParaMcp(() => core.solicitudes(registro, rut))
  );
}
