import 'dotenv/config';
import * as fs from 'fs';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { F29Scraper } from '../scrapers/f29';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Verifica el scraper HTTP del F29 (armado desde cero, sin captura pegada)
// contra el SII real: para cada período pedido, el estado de la declaración y el
// PDF del compacto. El criterio es que folio y codInt salgan, que el PDF empiece
// con %PDF-, y que un período sin declarar dé NO_ENCONTRADO.
const NOMBRE = (process.argv[2] ?? 'mercado') as NombrePerfil;
const PERIODOS = (process.env.VERIF_PERIODOS ?? '202601,202507,203001').split(',').map(Number);

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
    const scraper = new F29Scraper(new SiiHttpClient(sesion), sesion);
    console.log(`Perfil ${NOMBRE} (${p.rut})\n`);
    for (const periodo of PERIODOS) {
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      try {
        const e = await scraper.estadoDeclaracion(periodo);
        console.log(`${periodo}: folio=${e.folio} codInt=${e.codInt} estado=${e.estado} obs=${e.observaciones} `
          + `fecha=${e.fechaPresentacion} moneda=${e.moneda}`);
        await new Promise(r => setTimeout(r, pausaConfigurada()));
        const pdf = await scraper.pdfCompacto(e.folio, e.codInt);
        const firma = pdf.subarray(0, 5).toString('latin1');
        console.log(`   PDF compacto: ${pdf.length} bytes, firma ${firma}`);
        if (process.env.VERIF_SALIDA && firma === '%PDF-') {
          fs.writeFileSync(`${process.env.VERIF_SALIDA}-${periodo}.pdf`, pdf);
        }
      } catch (err) {
        console.log(`${periodo}: ${(err as Error).constructor.name} — ${(err as Error).message.slice(0, 120)}`);
      }
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
