import { z } from 'zod';
import * as core from '../../core/situacionTributaria';
import { schemaSituacionTributaria } from '../../core/schemas/situacionTributaria';
import { partirRut, digitoVerificador } from '../../rut';
import { RutaHandler, ejecutar, badRequest } from './comun';

const zodSituacion = z.object(schemaSituacionTributaria);

// Consulta pública de situación tributaria de terceros. A diferencia del resto
// del adaptador REST, NO recibe `clave` ni `certificado` ni usa una sesión del
// SII: es una consulta abierta por RUT. Igual pasa por el auth de tenant y el
// rate-limit del server (está en el mismo Map de rutas).
export function registrarRutasContribuyente(rutas: Map<string, RutaHandler>): void {
  rutas.set('POST /v1/contribuyente/situacion-tributaria', async body => {
    const parseo = zodSituacion.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);

    // Un RUT mal formado es un error del llamador (400), no un fallo del SII
    // (que devolvería el ERROR genérico si `partirRut` explota dentro del core).
    //
    // Se valida el dígito verificador y no sólo la forma. `partirRut` mira la
    // forma nada más, y el SII resuelve la consulta por el CUERPO del RUT: un
    // DV mal escrito devolvía los datos del contribuyente igual, con el DV ya
    // corregido en la respuesta. O sea que un RUT inválido salía por la API
    // como válido, y quien lo use para decidir con quién factura se queda con
    // un RUT que el SII va a rechazar más adelante. El chequeo de módulo 11
    // cuesta nada y es determinístico: es un 400, no una consulta al portal.
    try {
      const { rut, dv } = partirRut(parseo.data.rut);
      if (dv !== digitoVerificador(rut)) {
        return {
          status: 400,
          body: {
            error: 'BAD_REQUEST',
            detalle: `rut: dígito verificador inválido (para ${rut} corresponde ${digitoVerificador(rut)})`,
          },
        };
      }
    } catch {
      return { status: 400, body: { error: 'BAD_REQUEST', detalle: 'rut: formato inválido' } };
    }

    return ejecutar(() => core.situacionTributaria(parseo.data.rut));
  });
}
