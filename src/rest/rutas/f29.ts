import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/f29';
import { schemaEstadoF29, schemaCompactoF29, schemaPropuestaF29 } from '../../core/schemas/f29';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Formulario 29 (IVA mensual). Consulta del portal, detrás del login, con la
// credencial estándar.
const zodEstado = conCredencial(schemaEstadoF29);
const zodCompacto = conCredencial(schemaCompactoF29);
const zodPropuesta = conCredencial(schemaPropuestaF29);

// Marcador interno para sacar el caso "el SII no arma propuesta" a través de
// `ejecutar`, que envuelve todo lo que no lanza como `{ok:true, ...}`. El nombre
// lleva un prefijo que ningún campo del SII usa, y el handler lo consume y lo
// reemplaza antes de responder: nunca llega al JSON del consumidor.
const SIN_PROPUESTA = '__sin_propuesta';

export function registrarRutasF29(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/f29/estado-declaracion', async body => {
    const p = zodEstado.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, periodo } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(() => core.estadoDeclaracion(ejecutor, rut, periodo));
  });


  // Propuesta de casilleros del período: la tercera fuente de una cuadratura,
  // junto al libro propio y al RCV.
  //
  // Lo que NO se expone, y es deliberado:
  //
  //   - `resultadoCalculoPP29.traza` lleva el RUT y el período del contribuyente
  //     en texto libre. No va en la respuesta NI en logs.
  //   - `listCodBase` es la identificación del contribuyente —razón social,
  //     dirección, comuna—. Quien pregunta ya sabe por qué RUT preguntó; devolver
  //     su domicilio de paso es filtrar datos que nadie pidió.
  //
  // Los `codigo` van SIN normalizar y los `valor` como STRING, tal como los
  // entrega el SII: normalizar acá obligaría a decidir por el consumidor si un
  // casillero es entero o decimal (la tasa del código 115 viene "0.125").
  rutas.set('POST /v1/f29/propuesta', async body => {
    const p = zodPropuesta.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, periodo } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    const respuesta = await ejecutar(async () => {
      const r = await core.propuesta(ejecutor, rut, periodo);
      if (r.casilleros === null) return { [SIN_PROPUESTA]: true };
      return {
        casilleros: r.casilleros,
        tipo_propuesta: r.tipoPropuesta,
        fecha_creacion: r.fechaCreacion,
        complemento_detalle_dte: r.complementoDetalleDTE,
        documentos_del_giro: r.documentosDelGiro,
        // Cuándo consultamos NOSOTROS, no el SII: la propuesta se recalcula sola
        // cuando llega un documento tarde, así que una comparación sin marca de
        // tiempo no se puede auditar después.
        generada_en: new Date().toISOString(),
      };
    });

    // Que el SII no arme propuesta para el período es un resultado LEGÍTIMO, no
    // un fallo: el marcador interno se convierte acá en un código propio, para
    // que el consumidor lo distinga de un error de credenciales o de red — que
    // sí se reintentan, y reintentar esto no cambiaría nada.
    // Se exige status 200 además del marcador: un cuerpo de error con una clave
    // parecida nunca puede terminar leyéndose como "sin propuesta".
    const cuerpo = respuesta.body as Record<string, unknown>;
    if (respuesta.status === 200 && cuerpo?.[SIN_PROPUESTA]) {
      // Lleva `generada_en` igual que el caso con propuesta: "preguntamos y el
      // SII no propuso nada" es un hecho fechable, y sin la marca el consumidor
      // no puede auditar cuándo lo preguntó.
      return {
        status: 200,
        body: { ok: false, error: 'SIN_PROPUESTA', generada_en: new Date().toISOString() },
      };
    }
    return respuesta;
  });

  rutas.set('POST /v1/f29/formulario-compacto', async body => {
    const p = zodCompacto.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, periodo } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(async () => {
      const c = await core.compacto(ejecutor, rut, periodo);
      // El PDF se envuelve a mano: `ejecutar` spreadea el resultado y un Buffer
      // spreadeado da {"0":37,...}. Mismo contrato que los demás PDF.
      return {
        periodo: c.periodo, folio: c.folio, estado: c.estado, observaciones: c.observaciones,
        fecha_presentacion: c.fechaPresentacion, moneda: c.moneda,
        content_type: 'application/pdf',
        nombre_archivo: `f29-compacto-${c.periodo}.pdf`,
        tamano_bytes: c.pdf.length,
        pdf_base64: c.pdf.toString('base64'),
      };
    });
  });
}
