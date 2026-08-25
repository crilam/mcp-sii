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
const ANIO = Number(process.env.RET_ANIO ?? 2026);
// Un RET_ANIO mal escrito da NaN y el barrido consultaría el año "NaN": el SII
// respondería un informe vacío y la salida diría "ninguna boleta con retención",
// que es exactamente la conclusión que este script existe para sacar. Un
// resultado falso indistinguible del verdadero, así que se corta antes.
if (!Number.isInteger(ANIO) || ANIO < 2000 || ANIO > 2100) {
  throw new Error(`RET_ANIO inválido: "${process.env.RET_ANIO}". Se espera un año entre 2000 y 2100.`);
}

function ejecutorDe(sesion: SessionManager): EjecutorSesion<SessionManager> {
  return { ejecutar: (_rut, fn) => fn(sesion) };
}

async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_RUT y/o SII_CLAVE en el entorno.');

  const browser = new Browser(`ret-${Date.now()}`);
  const sesion = new SessionManager({ rut, clave, strategy: AuthStrategy.Clave }, browser);
  const ej = ejecutorDe(sesion);

  try {
    const resumen = await core.resumen(ej, rut, ANIO);
    const conActividad = resumen.meses.filter(
      m => m.emisionesVigentes > 0 || m.emisionesAnuladas > 0
    );
    console.log(`${ANIO}: ${conActividad.length} mes(es) con actividad\n`);

    let encontrados = 0;
    for (const mes of conActividad) {
      const boletas = await core.listEmitidas(ej, rut, ANIO, mes.mes);
      const conRetencion = boletas.filter(b => (b.retencionEmisor ?? 0) !== 0);
      const marca = conRetencion.length ? '  <<< RETENCION EMISOR != 0' : '';
      console.log(
        `${String(mes.mes).padStart(2, '0')}: ${boletas.length} boleta(s), ` +
        `ret.emisor distinta de 0 en ${conRetencion.length}${marca}`
      );
      for (const b of conRetencion) {
        encontrados++;
        console.log(
          `    folio ${b.folio} | ${b.fecha} | bruto=${b.honorarioBruto.toLocaleString('es-CL')} | ` +
          `ret.emisor=${b.retencionEmisor?.toLocaleString('es-CL')} | ` +
          `ret.receptor=${b.retencionReceptor.toLocaleString('es-CL')} | ` +
          `liquido=${b.totalLiquido.toLocaleString('es-CL')}`
        );
      }
    }

    console.log(
      encontrados
        ? `\nRESULTADO: ${encontrados} boleta(s) con retención del emisor. Sirve para cruzar con el portal.`
        : '\nRESULTADO: ninguna boleta con retención del emisor en el año. ' +
          'La convención sigue sin poder confirmarse con este RUT.'
    );
  } finally {
    await cerrarSesionDeScript(sesion);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
