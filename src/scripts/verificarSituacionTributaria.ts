import { situacionTributaria } from '../core/situacionTributaria';

// Verifica la consulta pública de situación tributaria contra el SII real, con
// el transporte de verdad (fetch, TLS verificado, sin curl). No necesita
// credenciales: es una consulta abierta del portal.
//
// Se pasa el RUT por argumento para no versionar el de nadie:
//   npm run verificar-situacion-tributaria -- 22222222-2
async function main() {
  const rut = process.argv[2];
  if (!rut) {
    throw new Error('Uso: npm run verificar-situacion-tributaria -- <rut>');
  }

  console.log(`Consultando ${rut}...\n`);
  const t0 = Date.now();
  const s = await situacionTributaria(rut);
  const ms1 = Date.now() - t0;

  console.log(`rut:                    ${s.rut}`);
  console.log(`razonSocial:            ${s.razonSocial}`);
  console.log(`inicioActividades:      ${s.inicioActividades}`);
  console.log(`fechaInicioActividades: ${s.fechaInicioActividades}`);
  console.log(`proPyme:                ${s.proPyme}`);
  console.log(`monedaExtranjera:       ${s.monedaExtranjera}`);
  console.log(`actividades:            ${s.actividades.length}`);
  for (const a of s.actividades) {
    console.log(`   ${a.codigo} | cat ${a.categoria} | IVA ${a.afectaIva} | ${a.giro}`);
  }

  // La segunda consulta tiene que salir del caché: si tarda parecido a la
  // primera, el caché no está funcionando y le estamos pegando al SII de más.
  const t1 = Date.now();
  await situacionTributaria(rut);
  const ms2 = Date.now() - t1;
  console.log(`\n1ra consulta: ${ms1} ms (fue al SII)`);
  console.log(`2da consulta: ${ms2} ms (debería salir del caché, ~0 ms)`);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
