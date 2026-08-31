import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// SPIKE de factibilidad del RCV asíncrono. Del bundle (relevarRcvAsync) el flujo
// es: getCtrlAsync(generaCtrl:true) CREA la solicitud, getCtrlAsync(generaCtrl:
// false) hace polling, obtenerArchivoBLOB descarga el .csv.gz. La incógnita que
// decide todo: la creación en el portal pasa por `pedirToken` (reCAPTCHA). Si el
// SII exige un token válido para crear, el async NO es alcanzable server-side
// (igual que el portal de vehículos con su captcha). Este script lo prueba
// contra el SII real, sin implementar nada.
const NOMBRE = (process.env.SPIKE_PERFIL ?? 'mercado') as NombrePerfil;
const PERIODO = process.env.SPIKE_PERIODO ?? '202601';
const OPERACION = process.env.SPIKE_OPERACION ?? 'COMPRA';
const TIPODOC = process.env.SPIKE_TIPODOC ?? '33';
const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NS = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);

  await registro.ejecutar(p.rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    const { rut, dv } = sesion.identidad();
    const base = (generaCtrl: boolean) => ({
      rutEmisor: rut, dvEmisor: dv, ptributario: PERIODO, codTipoDoc: TIPODOC,
      generaCtrl, operacion: OPERACION, estadoContab: 'REGISTRO', totDoc: 0,
      accionRecaptcha: '', tokenRecaptcha: '',
    });
    const ver = (etiqueta: string, resp: unknown) => {
      const r = resp as { respEstado?: { codRespuesta?: number; msgeRespuesta?: string }; data?: unknown };
      const cod = r?.respEstado?.codRespuesta;
      const msg = r?.respEstado?.msgeRespuesta ?? '';
      const filas = Array.isArray(r?.data) ? (r!.data as unknown[]).length : (r?.data == null ? 'null' : 'obj');
      console.log(`${etiqueta}: codRespuesta=${cod} filas=${filas} msg="${String(msg).slice(0, 120)}"`);
      if (Array.isArray(r?.data) && (r!.data as unknown[]).length) {
        console.log('   primera fila:', JSON.stringify((r!.data as unknown[])[0]).slice(0, 400));
      }
      return { cod, filas };
    };

    console.log(`Perfil ${NOMBRE} (${p.rut}), período ${PERIODO}, ${OPERACION} tipo ${TIPODOC}\n`);

    console.log('1. Poll sin crear (generaCtrl=false) — no debería pedir recaptcha');
    ver('   poll', await http.postSdi(BASE, NS, 'getCtrlAsync', base(false)));

    console.log('\n2. Crear (generaCtrl=true) con token recaptcha VACÍO — la prueba clave');
    const creado = ver('   crear', await http.postSdi(BASE, NS, 'getCtrlAsync', base(true)));
    console.log(`\n   Veredicto creación: ${creado.cod === 98 ? 'RECAPTCHA (98): async NO alcanzable sin token' : creado.cod === 0 || creado.cod === 1 ? 'ACEPTA sin token: async alcanzable' : `código ${creado.cod}, revisar`}`);

    console.log('\n3. Polling hasta TERMINADO (máx 12 intentos, ~8s c/u)');
    const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));
    let fila: any = null;
    for (let i = 0; i < 12; i++) {
      await dormir(8000);
      const resp = await http.postSdi(BASE, NS, 'getCtrlAsync', base(false)) as { data?: any[] };
      fila = (resp.data ?? []).find(f => f.caPeriodo === Number(PERIODO) && String(f.caTipoDoc) === TIPODOC) ?? (resp.data ?? [])[0];
      console.log(`   intento ${i + 1}: caEstado=${fila?.caEstado} caIdBLOB=${fila?.caIdBLOB} lineas=${fila?.caNumLineas} size=${fila?.caFileSize}`);
      if (fila?.caEstado === 'TERMINADO') break;
    }

    if (fila?.caEstado === 'TERMINADO' && fila.caIdBLOB && fila.caIdBLOB !== 'SIN-BLOB') {
      console.log('\n4. Descargar el BLOB (probando `usuario` = rut autenticado)');
      const url = `${BASE}/obtenerArchivoBLOB/${fila.caIdBLOB}/${rut}/${rut}/${fila.caId}`;
      try {
        const { contenido, contentType } = await http.getBinario(url);
        const firma = contenido.subarray(0, 4);
        console.log(`   ${contenido.length} bytes, ct=${contentType}, magic=${Array.from(firma).map(b => b.toString(16)).join(' ')}`);
        console.log(`   gzip? ${firma[0] === 0x1f && firma[1] === 0x8b ? 'SÍ (.csv.gz)' : 'no'}`);
        const zlib = await import('zlib');
        if (firma[0] === 0x1f) {
          const csv = zlib.gunzipSync(contenido).toString('latin1');
          console.log(`   CSV descomprimido: ${csv.length} bytes. Cabecera:`);
          console.log('   ' + csv.split(/\r?\n/).slice(0, 2).join('\n   ').slice(0, 500));
        }
      } catch (e) {
        console.log(`   descarga falló: ${(e as Error).message.slice(0, 160)}`);
      }
    } else {
      console.log('\n4. No llegó a TERMINADO en el tiempo del spike (o sin BLOB).');
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
