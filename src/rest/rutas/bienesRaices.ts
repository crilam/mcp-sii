import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bienesRaices';
import { schemaListBienesRaices } from '../../core/schemas/bienesRaices';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar } from './comun';

const zodListBienesRaices = z.object(schemaListBienesRaices).extend({ clave: z.string().min(1) });

export function registrarRutasBienesRaices(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/persona/bienes-raices', async body => {
    const parseo = zodListBienesRaices.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listBienesRaices(ejecutor, rut));
  });
}
