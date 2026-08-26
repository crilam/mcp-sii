import { recorrerConRitmo } from '../ritmoSii';

// Fase 0 de la ronda 5 (indicadores). A diferencia de las rondas anteriores,
// estas páginas son PÚBLICAS: no hay sesión, ni cookie jar, ni credencial. Se
// piden con fetch directo.
//
// Va CON RITMO igual que los barridos autenticados. Que no haya credencial no
// significa que el SII no cuente las requests: el corte por volumen del RCV fue
// por patrón de uso, no por sesión.
//
// La pregunta que contesta: ¿el HTML de cada indicador es parseable de forma
// estable, o hay que renderizar? Si alguno viniera armado por JavaScript, ese
// indicador se cae de la ronda o pide otro camino.
const BASE = 'https://www.sii.cl/valores_y_fechas';

const INDICADORES = [
  { nombre: 'uf', ruta: (a: number) => `uf/uf${a}.htm` },
  { nombre: 'utm-uta-ipc', ruta: (a: number) => `utm/utm${a}.htm` },
  { nombre: 'dolar', ruta: (a: number) => `dolar/dolar${a}.htm` },
  { nombre: 'correccion-monetaria', ruta: (a: number) => `correccion_monetaria/correccion${a}.htm` },
  { nombre: 'impuesto-2da-categoria', ruta: (a: number) => `impuesto_2da_categoria/impuesto${a}.htm` },
  { nombre: 'impuesto-2da-categoria-art52', ruta: (a: number) => `impuesto_2da_categoria/impuesto${a}_art52.htm` },
];

const ANIO = Number(process.argv[2] ?? new Date().getFullYear());

function describir(html: string): string {
  const tablas = (html.match(/<table/gi) ?? []).length;
  const filas = (html.match(/<tr/gi) ?? []).length;
  const celdas = (html.match(/<td/gi) ?? []).length;
  // Si el contenido lo arma JavaScript, el HTML servido trae poco o nada de
  // tabla. Es la señal que decide si el indicador se puede parsear del fuente.
  const conScriptPesado = /document\.write|angular|\.js\?/.test(html);
  return `${html.length} bytes, ${tablas} tabla(s), ${filas} fila(s), ${celdas} celda(s)` +
    (conScriptPesado ? '  OJO: la página trae JS que podría armar el contenido' : '');
}

async function main() {
  console.log(`Relevando indicadores del SII para ${ANIO}\n`);

  await recorrerConRitmo(INDICADORES, async ({ nombre, ruta }) => {
    const url = `${BASE}/${ruta(ANIO)}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) {
        console.log(`  ${nombre.padEnd(32)} HTTP ${resp.status}  ${url}`);
        return;
      }
      // Estas páginas son latin1 como el resto del SII: se lee el buffer y se
      // decodifica a mano, porque `resp.text()` asume UTF-8 y rompe los acentos.
      const buf = Buffer.from(await resp.arrayBuffer());
      const html = buf.toString('latin1');
      console.log(`  ${nombre.padEnd(32)} OK  ${describir(html)}`);

      // Un pedazo de la primera fila con datos, para ver la forma real.
      const filaConNumeros = html.split(/<tr/i).find(f => /\d{1,3}[.,]\d{3}/.test(f));
      if (filaConNumeros) {
        const texto = filaConNumeros.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`      muestra: ${texto.slice(0, 120)}`);
      }
    } catch (e) {
      console.log(`  ${nombre.padEnd(32)} FALLA  ${(e as Error).message.slice(0, 60)}`);
    }
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
