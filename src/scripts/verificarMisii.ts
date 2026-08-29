import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { SiiHttpClient } from '../http';
import { MisiiScraper } from '../scrapers/misii';
import { normalizar } from '../core/misii';
import { cerrarSesionSii } from '../cerrarSesionSii';

// Verifica la ficha contra el SII real. No alcanza con "que no falle": el
// criterio de terminado de la ronda pide contrastar los VALORES, porque un
// parser que toma el campo equivocado devuelve datos plausibles y mal.
//
// Imprime lo justo para contrastar a ojo contra el portal, sin volcar el
// payload entero: son datos reales del contribuyente.
async function main() {
  const rut = process.env.SII_EMPRESA_RUT ?? process.env.SII_RUT;
  const clave = process.env.SII_EMPRESA_CLAVE ?? process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_EMPRESA_RUT/SII_EMPRESA_CLAVE en el entorno.');

  const sesion = new SessionManager(
    { rut, clave, strategy: AuthStrategy.Clave }, new Browser(`verificar-misii-${Date.now()}`));

  try {
    // `authenticateOnly`: estas páginas cuelgan de la identidad autenticada, no
    // del contribuyente seleccionado en mipyme.
    await sesion.authenticateOnly();
    const scraper = new MisiiScraper(new SiiHttpClient(sesion));
    const ficha = normalizar(await scraper.ficha(), new Date().toISOString());

    console.log(`rut                     ${ficha.rut}`);
    console.log(`razonSocial             ${ficha.razonSocial}`);
    console.log(`tipo                    ${ficha.tipoContribuyente.descripcion} / ${ficha.subtipoContribuyente.descripcion}`);
    console.log(`constitucion            ${ficha.fechaConstitucion}`);
    console.log(`inicioActividades       ${ficha.fechaInicioActividades}`);
    console.log(`terminoGiro             ${ficha.fechaTerminoGiro}`);
    console.log(`segmento                ${ficha.segmento.codigo} ${ficha.segmento.descripcion}`);
    console.log(`regimen                 ${ficha.regimen
      ? `${ficha.regimen.codigo} "${ficha.regimen.descripcion}" desde ${ficha.regimen.desde}`
      : 'NULL — no se pudo determinar'}`);
    console.log(`actividades             ${ficha.actividades.length}`);
    for (const a of ficha.actividades) {
      console.log(`   ${String(a.codigo).padEnd(8)} cat=${a.categoria} iva=${a.afectaIva} desde=${a.desde}`);
    }
    console.log(`direcciones             ${ficha.direcciones.length}`);
    for (const d of ficha.direcciones) {
      console.log(`   [${d.codigo}] ${d.tipo} — ${d.comuna.descripcion} (${d.comuna.codigo}), ${d.region.descripcion}`);
    }
    console.log(`atributos               ${ficha.atributos.map(a => a.codigo).join(', ')}`);
    console.log(`capturadoEn             ${ficha.capturadoEn}`);
    console.log(`parserVersion           ${ficha.parserVersion}`);

    // Controles de resultado conocido: lo que tiene que ser cierto pase lo que
    // pase. Un parser que devuelve la ficha de otro contribuyente, o fechas sin
    // normalizar, pasa desapercibido si sólo se mira que "trajo algo".
    const problemas: string[] = [];
    if (!ficha.rut.startsWith(rut.split('-')[0].replace(/\./g, ''))) {
      problemas.push(`el RUT de la ficha (${ficha.rut}) no es el que se pidió (${rut})`);
    }
    for (const [campo, valor] of Object.entries({
      fechaConstitucion: ficha.fechaConstitucion,
      fechaInicioActividades: ficha.fechaInicioActividades,
      regimenDesde: ficha.regimen?.desde,
    })) {
      if (valor && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) problemas.push(`${campo} no quedó en ISO: ${valor}`);
    }
    for (const a of ficha.actividades) {
      if (a.codigo !== null && !/^\d{6}$/.test(a.codigo)) {
        problemas.push(`el código ACTECO ${a.codigo} no tiene seis dígitos: se perdió un cero al normalizar`);
      }
    }
    if (ficha.actividades.some(a => a.afectaIva === null)) {
      problemas.push('alguna actividad quedó con afectaIva en null: el SII usa S/N, revisá el mapeo');
    }

    console.log(problemas.length ? `\nPROBLEMAS:\n - ${problemas.join('\n - ')}` : '\nControles OK.');
  } finally {
    await cerrarSesionSii(sesion);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
