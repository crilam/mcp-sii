import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { MipymeHttpScraper, EmitirDteParams } from '../scrapers/mipymeHttp';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Verifica el DRY-RUN de guardar borrador (confirmar:false, NO graba) contra el
// SII real. El grabado real (confirmar:true) NO se ejecuta acá: queda para OK
// puntual del usuario (aunque un borrador sea reversible, es una escritura).
const NOMBRE = (process.env.VERIF_PERFIL ?? 'certificado') as NombrePerfil;
const EMPRESA = process.env.VERIF_EMPRESA;

async function main() {
  const p = perfil(NOMBRE);
  const cred = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') cred.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  else cred.guardar(p.rut, p.credencial.clave);
  const registro = crearRegistroSesionesSii(cred);

  const params: EmitirDteParams = {
    empresaRut: EMPRESA,
    tipoDte: 33,
    receptor: { rut: '66666666', dv: '6', razonSocial: 'CLIENTE DE PRUEBA SPA', giro: 'Servicios', direccion: 'Calle Falsa 123', comuna: 'Santiago', ciudad: 'Santiago' },
    lineas: [{ nombre: 'Servicio prueba', cantidad: 1, precioUnitario: 10000 }],
  };

  await registro.ejecutar(p.rut, async sesion => {
    const scraper = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    console.log(`Perfil ${NOMBRE} (${p.rut})\nDry-run de guardar borrador (confirmar:false, NO graba):`);
    const r = await scraper.guardarBorrador(params, false);
    console.log(`  guardado=${r.guardado} borradorId=${r.borradorId}`);
    console.log(`  resumen: tipo=${r.resumen.tipoDte} emisor=${r.resumen.emisorRut} receptor=${r.resumen.receptorRut} neto=${r.resumen.neto} iva=${r.resumen.iva} total=${r.resumen.total}`);
    console.log('\n(No se grabó ningún borrador: confirmar:true queda para OK puntual del usuario.)');
  });
}
main().catch(e => { console.error('ERROR:', e.constructor.name, '-', e.message); process.exit(1); });
