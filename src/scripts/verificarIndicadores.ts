import { uf, dolar, utm, correccionMonetaria, impuesto2daCategoria, impuesto2daCategoriaArt52 } from '../scrapers/indicadores';
import { recorrerConRitmo } from '../ritmoSii';

// Verifica los indicadores contra el SII real. No es sólo "que no falle": el
// criterio de terminado de la ronda pide contrastar los VALORES con el portal,
// porque un parser de tablas que agarra la columna corrida devuelve números
// plausibles y equivocados.
//
// Va con ritmo: son páginas públicas, pero el SII cuenta las requests igual.
// Se valida el año en vez de confiar en `Number`: con un argumento no numérico
// esto era `NaN` y el script salía a pedirle al SII `uf/ufNaN.htm` —una consulta
// segura de fallar, contra un portal que cuenta cada request para cortar por
// volumen. Un año fuera de rango tampoco tiene sentido pedirlo.
const ANIO = Number(process.argv[2] ?? 2025);
if (!Number.isInteger(ANIO) || ANIO < 1990 || ANIO > 2100) {
  console.error(`Año inválido: ${process.argv[2]}. Uso: npm run verificar-indicadores -- <año>`);
  process.exit(1);
}

const CONSULTAS = [
  { nombre: 'uf', fn: () => uf(ANIO) },
  { nombre: 'dolar', fn: () => dolar(ANIO) },
  { nombre: 'utm/uta/ipc', fn: () => utm(ANIO) },
  { nombre: 'correccion-monetaria', fn: () => correccionMonetaria(ANIO) },
  { nombre: 'impuesto-2da-categoria', fn: () => impuesto2daCategoria(ANIO) },
  { nombre: 'impuesto-2da-categoria-art52', fn: () => impuesto2daCategoriaArt52(ANIO) },
];

async function main() {
  console.log(`Indicadores del SII para ${ANIO}\n`);

  await recorrerConRitmo(CONSULTAS, async ({ nombre, fn }) => {
    try {
      const filas = await fn() as {
        mes: number; dia?: number; valor?: number; valores?: unknown[];
        periodo?: string; desde?: number | null; hasta?: number | null; factor?: number | null;
      }[];
      const meses = new Set(filas.map(f => f.mes));
      console.log(`${nombre.padEnd(24)} ${filas.length} fila(s), meses: ${[...meses].sort((a, b) => a - b).join(',')}`);

      // Las tres primeras y la última: alcanza para ver si los valores están en
      // el mes correcto y con la magnitud correcta.
      for (const f of [...filas.slice(0, 3), filas[filas.length - 1]].filter(Boolean)) {
        // Tres formas distintas de fila —diaria, mensual y por tramo— y se
        // imprimen distinto: un impresor que asuma `valor` deja los tramos en
        // "undefined" y la verificación no verifica nada.
        let detalle: string;
        if (f.dia !== undefined) {
          detalle = `mes ${f.mes} día ${f.dia} = ${f.valor?.toLocaleString('es-CL')}`;
        } else if (f.periodo !== undefined) {
          detalle = `mes ${f.mes} ${f.periodo} ${f.desde ?? '-'} a ${f.hasta ?? 'sin tope'} factor ${f.factor ?? 'exento'}`;
        } else {
          detalle = `mes ${f.mes} = ${JSON.stringify(f.valores)}`;
        }
        console.log(`      ${detalle}`);
      }
    } catch (e) {
      console.log(`${nombre.padEnd(24)} FALLA  ${(e as Error).message.slice(0, 90)}`);
    }
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
