import 'dotenv/config';
import * as fs from 'fs';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { RegistroSesiones, EjecutorSesion } from '../registroSesiones';
import * as core from '../core/bhe';

// Certificación de las 4 operaciones de BHE contra el SII real, para contrastar
// con la UI de sii.cl. Ejercita el MISMO core que llaman las rutas REST (queda
// afuera sólo el transporte HTTP y la auth de tenant, que no dependen del SII).
//
// Imprime los valores tal como los devuelve la API, para poder compararlos
// campo por campo con lo que muestra el portal.
const ANIO = Number(process.env.CERT_ANIO ?? 2026);
const MES = Number(process.env.CERT_MES ?? 7);
const DIR = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : '/tmp';

// Un ejecutor de una sola sesión: alcanza para correr las cuatro operaciones
// seguidas sin reautenticar (el SII limita las sesiones simultáneas por RUT).
function ejecutorDe(sesion: SessionManager): EjecutorSesion<SessionManager> {
  return { ejecutar: (_rut, fn) => fn(sesion) };
}

const money = (n: number | null) =>
  n === null ? 'null' : n.toLocaleString('es-CL');

async function main() {
  const rut = process.env.SII_RUT!;
  const browser = new Browser(`cert-${Date.now()}`);
  const sesion = new SessionManager(
    { rut, clave: process.env.SII_CLAVE!, strategy: AuthStrategy.Clave }, browser);
  const ej = ejecutorDe(sesion);

  const salida: string[] = [];
  const p = (linea: string) => { salida.push(linea); console.log(linea); };

  p(`RUT consultado: ${rut}   |   período: ${String(MES).padStart(2, '0')}/${ANIO}`);

  // 1. RESUMEN ANUAL
  p('\n=== 1) POST /v1/bhe/resumen  { anio } ===');
  const resumen = await core.resumen(ej, rut, ANIO);
  p(`contribuyente: ${resumen.nombreContribuyente}`);
  p(`rut informado: ${resumen.rut}   folios del año: ${resumen.folioInicial} a ${resumen.folioFinal}`);
  p('mes | folios | vigentes | anuladas | bruto | ret.terceros | ret.contribuyente | LIQUIDO');
  for (const m of resumen.meses) {
    p(`${String(m.mes).padStart(2, '0')} | ${m.folioInicial}-${m.folioFinal} | ${m.emisionesVigentes} | ${m.emisionesAnuladas} | ` +
      `${money(m.honorarioBruto)} | ${money(m.retencionTerceros)} | ${money(m.retencionContribuyente)} | ${money(m.totalLiquido)}`);
  }
  const suma = (f: (m: typeof resumen.meses[0]) => number) => resumen.meses.reduce((a, m) => a + f(m), 0);
  p(`TOTALES: vigentes=${suma(m => m.emisionesVigentes)} anuladas=${suma(m => m.emisionesAnuladas)} ` +
    `bruto=${money(suma(m => m.honorarioBruto))} ret.terceros=${money(suma(m => m.retencionTerceros))} ` +
    `ret.contrib=${money(suma(m => m.retencionContribuyente))} LIQUIDO=${money(suma(m => m.totalLiquido))}`);

  // 1b. RESUMEN ANUAL DE RECIBIDAS
  p('\n=== 1b) POST /v1/bhe/resumen-recibidas  { anio } ===');
  const resumenRec = await core.resumenRecibidas(ej, rut, ANIO);
  p('mes | folios | vigentes | anuladas | bruto | ret.terceros | ret.contribuyente | LIQUIDO');
  for (const m of resumenRec.meses) {
    p(`${String(m.mes).padStart(2, '0')} | ${m.folioInicial}-${m.folioFinal} | ${m.emisionesVigentes} | ${m.emisionesAnuladas} | ` +
      `${money(m.honorarioBruto)} | ${money(m.retencionTerceros)} | ${money(m.retencionContribuyente)} | ${money(m.totalLiquido)}`);
  }
  const sumRec = (f: (m: typeof resumenRec.meses[0]) => number) => resumenRec.meses.reduce((a, m) => a + f(m), 0);
  p(`TOTALES: vigentes=${sumRec(m => m.emisionesVigentes)} anuladas=${sumRec(m => m.emisionesAnuladas)} ` +
    `bruto=${money(sumRec(m => m.honorarioBruto))} ret.terceros=${money(sumRec(m => m.retencionTerceros))} ` +
    `ret.contrib=${money(sumRec(m => m.retencionContribuyente))} LIQUIDO=${money(sumRec(m => m.totalLiquido))}`);

  // 2. EMITIDAS DEL MES
  p(`\n=== 2) POST /v1/bhe/list-emitidas  { anio, mes } ===`);
  const emitidas = await core.listEmitidas(ej, rut, ANIO, MES);
  p(`boletas: ${emitidas.length}`);
  p('folio | fecha | fechaEmision | usuario | receptor | nombre | bruto | ret.emisor | ret.receptor | liquido | anulada | socProf | codigoBarras');
  for (const b of emitidas) {
    p(`${b.folio} | ${b.fecha} | ${b.fechaEmision} | ${b.usuarioEmisor} | ${b.contraparteRut} | ${b.contraparteNombre} | ` +
      `${money(b.honorarioBruto)} | ${money(b.retencionEmisor)} | ${money(b.retencionReceptor)} | ` +
      `${money(b.totalLiquido)} | ${b.anulada} | ${b.sociedadProfesional} | ${b.codigoBarras}`);
  }
  p(`SUMA del mes: bruto=${money(emitidas.reduce((a, b) => a + b.honorarioBruto, 0))} ` +
    `ret.receptor=${money(emitidas.reduce((a, b) => a + b.retencionReceptor, 0))} ` +
    `liquido=${money(emitidas.reduce((a, b) => a + b.totalLiquido, 0))}`);

  // 3. RECIBIDAS DEL MES
  p(`\n=== 3) POST /v1/bhe/list-recibidas  { anio, mes } ===`);
  try {
    const recibidas = await core.listRecibidas(ej, rut, ANIO, MES);
    p(`boletas: ${recibidas.length}`);
    p('folio | fecha | emisor | nombre | bruto | ret.emisor | ret.receptor | liquido | anulada | codigoBarras');
    for (const b of recibidas) {
      p(`${b.folio} | ${b.fecha} | ${b.contraparteRut} | ${b.contraparteNombre} | ` +
        `${money(b.honorarioBruto)} | ${money(b.retencionEmisor)} | ${money(b.retencionReceptor)} | ` +
        `${money(b.totalLiquido)} | ${b.anulada} | ${b.codigoBarras}`);
    }
    p(`SUMA del mes: bruto=${money(recibidas.reduce((a, b) => a + b.honorarioBruto, 0))}`);
  } catch (e) {
    p(`(sin recibidas o error: ${(e as Error).message.slice(0, 120)})`);
  }

  // 4. PDF de la primera emitida
  p(`\n=== 4) POST /v1/bhe/pdf  { codigo_barras } ===`);
  const primera = emitidas.find(b => b.codigoBarras);
  if (primera) {
    const pdf = await core.pdf(ej, rut, primera.codigoBarras, false);
    const ruta = `${DIR}/cert-bhe-folio-${primera.folio}.pdf`;
    fs.writeFileSync(ruta, pdf);
    p(`folio ${primera.folio} | codigo ${primera.codigoBarras} | ${pdf.length} bytes | ${pdf.subarray(0, 5).toString('latin1')}`);
    p(`PDF guardado en: ${ruta}`);
  } else {
    p('(sin boletas emitidas con código de barras en el mes)');
  }

  fs.writeFileSync(`${DIR}/certificacion-bhe.txt`, salida.join('\n'));
  console.log(`\n--- volcado en ${DIR}/certificacion-bhe.txt ---`);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
