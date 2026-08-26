import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { SiiHttpClient } from '../http';
import { partirRut } from '../rut';
import { cerrarSesionSii } from '../cerrarSesionSii';

// Releva QUÉ DEVUELVE cada método de lectura del facade de RCV, en una sola
// sesión. Los nombres salieron de `relevarMetodosSdi.ts`; esto contesta la otra
// mitad: si el método sirve, qué parámetros pide y qué shape tiene la respuesta.
//
// Sin este paso hay que implementar a ciegas y descubrir en el review que el
// método no devolvía lo que su nombre sugería.
//
// NO se llama `ingresarAceptacionReclamoDocs`: es ESCRITURA (acepta o reclama
// documentos frente a terceros) y va a la ronda de escritura, con confirmación
// explícita. Un relevamiento no dispara actos tributarios.
const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';

const PERIODO = process.env.RELEVAR_PERIODO ?? '202506';
const TIPO_DOC = Number(process.env.RELEVAR_TIPO_DOC ?? 33);

// Los métodos de LECTURA sin implementar. El `data` de cada uno se arma con el
// scope que usan los que ya funcionan; si a alguno le falta un parámetro, el
// propio SII lo dice en su respuesta y eso también es información.
function metodos(rut: string, dv: string) {
  const scope = {
    rutEmisor: rut, dvEmisor: dv, ptributario: PERIODO,
    estadoContab: 'REGISTRO', operacion: 'COMPRA',
  };
  const conTipo = { ...scope, codTipoDoc: TIPO_DOC };
  return [
    // El portal lo llama con data VACÍO: `getDatosInicio({}, null)` en su bundle.
    { nombre: 'getDatosInicio', data: {} },
    { nombre: 'getDcvEmpresasAutorizadas', data: scope },
    { nombre: 'getResumenExport', data: scope },
    { nombre: 'getDetalleCompraExport', data: conTipo },
    { nombre: 'getDetalleVentaExport', data: { ...conTipo, operacion: 'VENTA' } },
    { nombre: 'getCtrlAsync', data: scope },
    { nombre: 'getOtrosImpuestos', data: conTipo },
    { nombre: 'getEventosDoc', data: {} },
    { nombre: 'getDetalleDTE', data: conTipo },
    { nombre: 'getDetalleIEC02', data: conTipo },
    { nombre: 'getDetallesObs', data: conTipo },
    { nombre: 'getResumenObsCruce', data: scope },
    { nombre: 'getResumenObservacionesRutTpoDoc', data: scope },
    { nombre: 'getDetalleObservacionRutDoc', data: conTipo },
    { nombre: 'getDetalleObservacionTpoDoc', data: conTipo },
    { nombre: 'getDetalleObsCompraExp', data: conTipo },
  ];
}

// Describe la respuesta sin volcarla entera: interesa el SHAPE, no los datos.
function describir(r: any): string {
  const cod = r?.respEstado?.codRespuesta;
  const msg = r?.respEstado?.msgeRespuesta;
  const d = r?.data;
  let forma: string;
  if (d == null) forma = 'data=null';
  else if (Array.isArray(d)) {
    if (d.length === 0) forma = 'array vacío';
    else if (typeof d[0] === 'string') {
      forma = `array de ${d.length} string(s) — CSV con ${String(d[0]).split(';').length} columnas`;
    } else if (typeof d[0] === 'object') {
      forma = `array de ${d.length} objeto(s), claves: ${Object.keys(d[0]).slice(0, 10).join(',')}`;
    } else forma = `array de ${d.length} ${typeof d[0]}`;
  } else if (typeof d === 'object') {
    forma = `objeto, claves: ${Object.keys(d).slice(0, 12).join(',')}`;
  } else forma = `${typeof d} = ${JSON.stringify(d).slice(0, 60)}`;
  return `cod=${cod}${msg ? ` msg="${String(msg).slice(0, 40)}"` : ''}  ${forma}`;
}

async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  const empresa = process.env.SII_EMPRESA_RUT ?? rut;
  if (!rut || !clave) throw new Error('Faltan SII_RUT/SII_CLAVE en el entorno.');

  const sesion = new SessionManager(
    { rut, clave, strategy: AuthStrategy.Clave }, new Browser(`relevar-${Date.now()}`));

  try {
    const http = new SiiHttpClient(sesion);
    const { rut: rutEmpresa, dv } = partirRut(empresa!, 'RUT de empresa');
    console.log(`empresa=${rutEmpresa}-${dv} periodo=${PERIODO} tipo_doc=${TIPO_DOC}\n`);

    for (const { nombre, data } of metodos(rutEmpresa, dv)) {
      try {
        const r = await http.postSdi(BASE, NAMESPACE, nombre, data);
        console.log(`${nombre.padEnd(34)} ${describir(r)}`);
        // Para el método que se va a implementar hace falta el detalle, no sólo
        // el shape: qué trae cada campo y con qué valores.
        if (nombre === process.env.RELEVAR_DETALLE_DE) {
          const filas = r?.data as Record<string, unknown>[];
          console.log('   --- primera fila completa:');
          for (const [k, v] of Object.entries(filas[0] ?? {})) {
            console.log(`       ${k.padEnd(30)} ${JSON.stringify(v)}`);
          }
          console.log(`   --- ${filas.length} filas; RUT de empresa distintos: ` +
            `${new Set(filas.map(f => f.usrEmpRut)).size}`);
        }
      } catch (e) {
        console.log(`${nombre.padEnd(34)} FALLA  ${(e as Error).message.slice(0, 70)}`);
      }
    }
  } finally {
    await cerrarSesionSii(sesion);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
