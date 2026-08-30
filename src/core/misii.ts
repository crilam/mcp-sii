import { MisiiScraper, DatosContribuyente } from '../scrapers/misii';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { LimitacionConocida } from '../erroresConsulta';
import { partirRut } from '../rut';

/** La ficha más la procedencia de la captura. */
export type FichaContribuyente = DatosContribuyente & {
  /** Cuándo se leyó DEL SII, no cuándo se respondió. */
  capturadoEn: string;
};

export async function datosContribuyente(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<FichaContribuyente> {
  return ejecutor.ejecutar(rut, async sesion => {
    const datos = await new MisiiScraper(new SiiHttpClient(sesion), sesion).datosContribuyente();

    // La ficha es de la IDENTIDAD AUTENTICADA, no del RUT que viaja en el
    // request. Hoy son el mismo —la credencial es la de ese RUT—, pero si
    // alguna vez difieren, el consumidor persistiría contra el RUT que pidió
    // una ficha que es de otro contribuyente, sin ninguna señal de que pasó.
    // Es el peor error que puede cometer este endpoint y cuesta una
    // comparación: se corta acá en vez de confiar en que no ocurra.
    const pedido = partirRut(rut, 'RUT del request');
    if (datos.rut !== `${pedido.rut}-${pedido.dv}`) {
      throw new LimitacionConocida(
        `Mi SII devolvió la ficha de ${datos.rut} y se pidió la de ${pedido.rut}-${pedido.dv}: `
        + 'no se entrega una identidad que no es la pedida.');
    }

    // Se sella donde LLEGA el dato del SII. Hoy es casi lo mismo que la hora de
    // la respuesta; en cuanto haya caché dejan de serlo, y fechar con la hora
    // del response afirmaría una confirmación contra el SII que no ocurrió en
    // ese momento — que es la fecha que el consumidor le muestra al usuario.
    return { ...datos, capturadoEn: new Date().toISOString() };
  });
}
