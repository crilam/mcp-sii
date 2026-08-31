import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Lectura pura: el catálogo de eventos de acuse/reclamo del RCV (getEventosDoc).
// No muta nada. Sirve para diseñar el contrato de /v1/rcv/acuse: qué códigos de
// evento (dedCodEvento) existen y qué significan.
const NOMBRE = (process.env.SPIKE_PERFIL ?? 'mercado') as NombrePerfil;
const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NS = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';

async function main() {
  const p = perfil(NOMBRE);
  const cred = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') cred.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  else cred.guardar(p.rut, p.credencial.clave);
  const registro = crearRegistroSesionesSii(cred);

  await registro.ejecutar(p.rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    console.log(`Perfil ${NOMBRE} (${p.rut})\ngetEventosDoc:`);
    const resp = await http.postSdi(BASE, NS, 'getEventosDoc', {}) as { respEstado?: { codRespuesta?: number }; data?: unknown };
    console.log(`  codRespuesta=${resp?.respEstado?.codRespuesta}`);
    const data = (resp as any)?.dataEventosDocs ?? resp?.data;
    if (Array.isArray(data)) {
      for (const e of data) console.log(`  ${JSON.stringify(e)}`);
    } else {
      console.log(`  data:`, JSON.stringify(data).slice(0, 800));
    }
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
