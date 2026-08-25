import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { EjecutorSesion } from '../registroSesiones';
import * as core from '../core/bhe';
import { cerrarSesionDeScript } from './cerrarSesionDeScript';

// La convención de `retencionEmisor` quedó verificada a medias: en recibidas es
// null (el SII no lo informa) y en emitidas, en todos los meses mirados hasta
// ahora, es 0. Falta el caso que confirma la otra mitad — una boleta con
// retención del emisor distinta de cero — para saber si el campo se lee bien o
// simplemente siempre devolvimos 0.
//
// Recorre los meses con actividad del año en UNA sola sesión: el SII limita las
// sesiones simultáneas por RUT, así que reautenticar por mes es la forma de que
// te bloqueen a mitad del barrido.
// Un RET_ANIO mal escrito da NaN y el barrido consultaría el año "NaN": el SII
// respondería un informe vacío y la salida diría "ninguna boleta con retención",
// que es exactamente la conclusión que este script existe para sacar. Un
// resultado falso indistinguible del verdadero, así que se corta antes.
//
// Se valida dentro de una función y no en el cuerpo del módulo para que el
// `main().catch()` del final lo agarre: un throw suelto acá escapa a ese catch y
// sale con stack trace crudo en vez del `ERROR: <mensaje>` del resto.
function anioDeEntorno(): number {
  const anio = Number(process.env.RET_ANIO ?? 2026);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
    throw new Error(`RET_ANIO inválido: "${process.env.RET_ANIO}". Se espera un año entre 2000 y 2100.`);
  }
  return anio;
}

// El ejecutor devuelve siempre la MISMA sesión, así que se verifica que el RUT
// pedido sea el suyo. Hoy el script consulta uno solo y no puede fallar; el día
// que alguien lo reuse para varios, sin este chequeo el barrido consultaría
// callado la sesión equivocada y atribuiría las boletas al RUT que no es.
function ejecutorDe(sesion: SessionManager, rutEsperado: string): EjecutorSesion<SessionManager> {
  return {
    ejecutar: (rut, fn) => {
      if (rut !== rutEsperado) {
        throw new Error(`El ejecutor es del RUT ${rutEsperado} y se pidió ${rut}.`);
      }
      return fn(sesion);
    },
  };
}

async function main() {
  const ANIO = anioDeEntorno();
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_RUT y/o SII_CLAVE en el entorno.');

  const browser = new Browser(`ret-${Date.now()}`);
  const sesion = new SessionManager({ rut, clave, strategy: AuthStrategy.Clave }, browser);
  const ej = ejecutorDe(sesion, rut);

  try {
    const resumen = await core.resumen(ej, rut, ANIO);
    const conActividad = resumen.meses.filter(
      m => m.emisionesVigentes > 0 || m.emisionesAnuladas > 0
    );
    console.log(`${ANIO}: ${conActividad.length} mes(es) con actividad\n`);

    // Los tres estados van SEPARADOS, y es el punto del script: `null` es "el
    // SII no informó el dato" y 0 es "informó cero". Colapsarlos con `?? 0`
    // haría que una boleta en null se contara como un cero informado, y la
    // conclusión final volvería a ser ambigua — que es exactamente la ambigüedad
    // que este barrido viene a resolver. En emitidas no debería aparecer ningún
    // null (el CGI trae `retencion_emisor`), así que si aparece es un hallazgo
    // por derecho propio y hay que verlo, no promediarlo.
    let conMonto = 0;
    let enNull = 0;
    for (const mes of conActividad) {
      const boletas = await core.listEmitidas(ej, rut, ANIO, mes.mes);
      const conRetencion = boletas.filter(
        b => b.retencionEmisor !== null && b.retencionEmisor !== 0
      );
      const nulls = boletas.filter(b => b.retencionEmisor === null);
      enNull += nulls.length;

      const marca = conRetencion.length ? '  <<< RETENCION EMISOR CON MONTO' : '';
      const avisoNull = nulls.length ? `, ${nulls.length} en null (inesperado en emitidas)` : '';
      console.log(
        `${String(mes.mes).padStart(2, '0')}: ${boletas.length} boleta(s), ` +
        `ret.emisor con monto en ${conRetencion.length}${avisoNull}${marca}`
      );
      for (const b of conRetencion) {
        conMonto++;
        console.log(
          `    folio ${b.folio} | ${b.fecha} | bruto=${b.honorarioBruto.toLocaleString('es-CL')} | ` +
          `ret.emisor=${b.retencionEmisor?.toLocaleString('es-CL')} | ` +
          `ret.receptor=${b.retencionReceptor.toLocaleString('es-CL')} | ` +
          `liquido=${b.totalLiquido.toLocaleString('es-CL')}`
        );
      }
    }

    const colaNull = enNull
      ? ` OJO: ${enNull} boleta(s) traen el campo en null, que en emitidas no se esperaba: ` +
        'revisar antes de sacar conclusiones.'
      : '';
    console.log(
      conMonto
        ? `\nRESULTADO: ${conMonto} boleta(s) con retención del emisor. Sirve para cruzar con el portal.${colaNull}`
        : '\nRESULTADO: ninguna boleta con retención del emisor en el año (todas informaron 0). ' +
          `La convención sigue sin poder confirmarse con este RUT.${colaNull}`
    );
  } finally {
    await cerrarSesionDeScript(sesion);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
