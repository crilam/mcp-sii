import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import { validarClave } from '../../httpServer';
import { RutaHandler } from './rcv';

const zodValidarClave = z.object({ rut: z.string(), clave: z.string().min(1) });

export function registrarRutasSesion(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/sesion/validar-clave', async body => {
    const parseo = zodValidarClave.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave } = parseo.data;
    const resultado = await validarClave(rut, clave, registro, credenciales);
    return { status: 200, body: resultado };
  });
}
