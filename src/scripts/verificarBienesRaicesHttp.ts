import 'dotenv/config';
import * as fs from 'fs';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { BienesRaicesHttpScraper } from '../scrapers/bienesRaicesHttp';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Verifica el scraper HTTP de bienes raíces contra el SII real: no sólo que
// responda, sino que los VALORES cuadren con lo que muestra el portal. El
// certificado de avalúo es una solicitud real que queda en el historial del
// contribuyente, así que se pide UNA sola vez y sólo si se pasa VERIF_CERT=1.
const NOMBRE = (process.argv[2] ?? 'certificado') as NombrePerfil;
const SALIDA_PDF = process.env.VERIF_SALIDA;

const pausa = () => new Promise(r => setTimeout(r, pausaConfigurada()));

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(
      p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword,
      process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);

  await registro.ejecutar(p.rut, async sesion => {
    const scraper = new BienesRaicesHttpScraper(new SiiHttpClient(sesion), sesion);
    console.log(`Perfil ${NOMBRE} (${p.rut})\n`);

    const r = await scraper.listBienesRaices();
    console.log(`propiedades: ${r.propiedades.length}  resumen: ${JSON.stringify(r.resumen)}`);
    for (const b of r.propiedades.slice(0, 3)) {
      console.log(`  ${b.comuna.padEnd(14)} ${b.rol.padEnd(12)} avalúo ${b.avaluoFiscal.toLocaleString('es-CL')}  `
        + `codigos ${b.comunaCodigo}/${b.manzana}/${b.predio} eac ${b.ultimoEacAplicado}  ${b.direccion.slice(0, 30)}`);
    }

    await pausa();
    const comunas = await scraper.comunas();
    console.log(`\ncomunas: ${comunas.length}  ej: ${JSON.stringify(comunas[0])}`);

    await pausa();
    const solicitudes = await scraper.solicitudes();
    console.log(`\nsolicitudes: ${solicitudes.length}`);
    for (const s of solicitudes) console.log(`  ${s.fecha} ${s.estado.padEnd(22)} ${s.tipo.slice(0, 50)}  ${s.url}`);

    const primera = r.propiedades[0];
    if (!primera) {
      console.log('\nSin propiedades: no se puede probar copropietarios, rol ni certificado.');
      return;
    }
    const rol = { comuna: primera.comunaCodigo, manzana: primera.manzana, predio: primera.predio };

    await pausa();
    const copro = await scraper.multipropietarios(rol);
    console.log(`\ncopropietarios de ${primera.rol}: ${copro.length}`);
    for (const c of copro) console.log(`  ${c.rut} ${c.porcentajeDerechos}% fojas ${c.fojas} nº ${c.numero} ${c.anio}`);

    await pausa();
    const consulta = await scraper.consultarPorRol(rol);
    console.log(`\nconsulta sin clave por rol ${primera.rol}: ${consulta.length}`);
    for (const c of consulta) console.log(`  ${JSON.stringify(c)}`);

    if (solicitudes[0]?.url) {
      await pausa();
      const doc = await scraper.descargarDocumento(solicitudes[0].url);
      console.log(`\ndocumento de la solicitud: ${doc.length} bytes, firma ${doc.subarray(0, 5).toString('latin1')}`);
    }

    if (process.env.VERIF_CERT === '1') {
      await pausa();
      const pdf = await scraper.certificadoAvaluo([{ ...rol, ultimoEacAplicado: primera.ultimoEacAplicado }], 'simple');
      console.log(`\ncertificado de avalúo simple: ${pdf.length} bytes, firma ${pdf.subarray(0, 5).toString('latin1')}`);
      if (SALIDA_PDF) { fs.writeFileSync(SALIDA_PDF, pdf); console.log(`  guardado en ${SALIDA_PDF}`); }
    } else {
      console.log('\n(certificado no pedido: VERIF_CERT=1 para pedir uno real)');
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
