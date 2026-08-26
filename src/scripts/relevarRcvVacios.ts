import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { SiiHttpClient } from '../http';
import { partirRut } from '../rut';
import { cerrarSesionSii } from '../cerrarSesionSii';

// Segunda vuelta de la Fase 0. Ocho métodos del facade de RCV responden bien
// pero vinieron VACÍOS con una empresa y un período: sin una fila real no se
// puede saber qué campos trae cada uno, y publicar un parseo no verificado es
// cómo se llega a una ruta que devuelve datos plausibles y mal.
//
// Esto los barre contra VARIAS empresas y períodos hasta encontrar datos. Cada
// combinación es una sesión del SII, así que se recorre en UNA sola sesión y en
// serie: el SII limita las simultáneas por RUT.
//
// También reintenta los dos que fallaron por parámetros y el que pide folio.
const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';

// Los que interesa poblar. `getCtrlAsync` va con scope de período; el resto
// necesita tipo de documento.
const VACIOS_CON_TIPO = [
  'getOtrosImpuestos', 'getDetalleIEC02', 'getDetallesObs',
  'getDetalleObservacionRutDoc', 'getDetalleObservacionTpoDoc',
  'getDetalleObsCompraExp',
];
const VACIOS_SIN_TIPO = [
  'getCtrlAsync', 'getResumenObsCruce', 'getResumenObservacionesRutTpoDoc',
];

// Se prueban varios tipos: las observaciones suelen colgar de facturas (33) y
// notas de crédito (61), y los otros impuestos de documentos específicos.
const TIPOS = [33, 34, 61, 46, 56];

// Devuelve null cuando NO hay datos que verificar. Ojo con el CSV: su primer
// elemento es la CABECERA, así que un array de un solo string son cero filas.
// Contarlo como "con datos" fue un falso positivo que hizo parecer que
// `getDetalleObsCompraExp` traía algo cuando sólo traía los nombres de columna
// — exactamente el tipo de resultado que este relevamiento existe para evitar.
function resumirData(d: unknown): string | null {
  if (!Array.isArray(d) || d.length === 0) return null;
  if (typeof d[0] === 'string') {
    const filas = d.length - 1;
    if (filas <= 0) return null;
    return `CSV ${String(d[0]).split(';').length} col, ${filas} fila(s)`;
  }
  return `${d.length} objeto(s): ${Object.keys(d[0] as object).slice(0, 12).join(',')}`;
}

async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_RUT/SII_CLAVE en el entorno.');

  // Empresas y períodos a barrer. Se toman del entorno para no versionar RUT.
  const empresas = (process.env.RELEVAR_EMPRESAS ?? process.env.SII_EMPRESA_RUT ?? rut)
    .split(',').map(e => e.trim()).filter(Boolean);
  const periodos = (process.env.RELEVAR_PERIODOS ?? '202506,202412,202312')
    .split(',').map(p => p.trim()).filter(Boolean);

  const sesion = new SessionManager(
    { rut, clave, strategy: AuthStrategy.Clave }, new Browser(`vacios-${Date.now()}`));

  try {
    const http = new SiiHttpClient(sesion);
    const hallazgos: string[] = [];

    for (const empresa of empresas) {
      const { rut: re, dv } = partirRut(empresa, 'RUT de empresa');
      for (const periodo of periodos) {
        const scope = {
          rutEmisor: re, dvEmisor: dv, ptributario: periodo,
          estadoContab: 'REGISTRO', operacion: 'COMPRA',
        };
        console.log(`\n=== empresa ${re}-${dv}  período ${periodo}`);

        for (const metodo of VACIOS_SIN_TIPO) {
          try {
            const r = await http.postSdi(BASE, NAMESPACE, metodo, scope);
            const res = resumirData(r?.data);
            if (res) {
              console.log(`  CON DATOS  ${metodo.padEnd(34)} ${res}`);
              hallazgos.push(`${metodo} @ ${re}-${dv}/${periodo}: ${res}`);
              if (metodo === process.env.RELEVAR_DETALLE_DE) {
                for (const fila of (r.data as Record<string, unknown>[]).slice(0, 3)) {
                  console.log('     --- fila:');
                  for (const [k, v] of Object.entries(fila)) {
                    console.log(`         ${k.padEnd(22)} ${JSON.stringify(v)}`);
                  }
                }
              }
            }
          } catch { /* ya sabemos que algunos fallan; no es el objetivo acá */ }
        }

        for (const metodo of VACIOS_CON_TIPO) {
          for (const tipo of TIPOS) {
            try {
              const r = await http.postSdi(BASE, NAMESPACE, metodo, { ...scope, codTipoDoc: tipo });
              const res = resumirData(r?.data);
              if (res) {
                console.log(`  CON DATOS  ${metodo.padEnd(34)} tipo ${tipo}  ${res}`);
                hallazgos.push(`${metodo} @ ${re}-${dv}/${periodo} tipo ${tipo}: ${res}`);
              }
            } catch { /* idem */ }
          }
        }
      }
    }

    console.log(`\n===== RESUMEN: ${hallazgos.length} combinación(es) con datos`);
    for (const h of hallazgos) console.log(`   ${h}`);
    if (!hallazgos.length) {
      console.log('   Ninguna. Los métodos siguen sin poder verificarse: no se implementan.');
    }
  } finally {
    await cerrarSesionSii(sesion);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
