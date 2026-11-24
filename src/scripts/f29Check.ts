import { writeFileSync } from 'fs';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { leerClaveDelLlavero } from '../claveLlavero';
import { verificarF29, rangoPeriodos } from '../f29Verificacion/recolector';
import { reporteEnTexto } from '../f29Verificacion/reporte';
import { partirRut } from '../rut';

// f29-check: revisa el F29 de una empresa, SÓLO LECTURA.
//   (1) si el F29 del último período vencido está declarado y
//   (2) si el último F29 declarado (o los del rango) cuadra con el RCV.
//
// La clave sale del Llavero de macOS (servicio `mcp-sii`, ver claveLlavero.ts):
// no se pide, no se imprime, no se escribe. La sesión del SII se cierra al
// terminar, pase lo que pase: el SII limita las sesiones simultáneas por RUT.
//
//   npm run f29-check -- --rut 11111111-1
//   npm run f29-check -- --rut 11111111-1 --periodo 202607
//   npm run f29-check -- --rut 11111111-1 --desde 202601 --hasta 202608 --json salida.json
//   npm run f29-check -- --rut 11111111-1 --propuesta 202610
//
// Opciones: --vence 12|20 (por defecto, el de la ficha de Mi SII),
// --feriado AAAA-MM-DD (repetible), --todo (también las filas que cuadran),
// --json <archivo> (además del texto; "-" lo imprime en vez del texto).

const AYUDA = 'Uso: f29-check --rut <empresa> [--periodo AAAAMM | --desde AAAAMM --hasta AAAAMM] [--propuesta AAAAMM] [--vence 12|20] [--feriado AAAA-MM-DD] [--todo] [--json <archivo|->]';

function opciones(argv: string[]) {
  const o: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}\n${AYUDA}`);
    const k = a.slice(2);
    const sinValor = k === 'todo' || k === 'ayuda' || k === 'help';
    (o[k] ??= []).push(sinValor ? 'true' : argv[++i]);
  }
  return o;
}

function periodoValido(s: string | undefined, nombre: string): number {
  if (!s || !/^\d{6}$/.test(s) || Number(s.slice(4)) < 1 || Number(s.slice(4)) > 12) {
    throw new Error(`--${nombre} debe ser AAAAMM.\n${AYUDA}`);
  }
  return Number(s);
}

async function main() {
  const o = opciones(process.argv.slice(2));
  if (o.ayuda || o.help || !o.rut) { console.log(AYUDA); process.exit(o.rut ? 0 : 2); }
  const p = partirRut(o.rut[0], '--rut');
  const rut = `${p.rut}-${p.dv}`;
  let periodos: number[] = [];
  if (o.periodo) periodos = [periodoValido(o.periodo[0], 'periodo')];
  if (o.desde || o.hasta) {
    periodos = rangoPeriodos(periodoValido(o.desde?.[0], 'desde'), periodoValido(o.hasta?.[0], 'hasta'));
    if (periodos.length === 0 || periodos.length > 24) throw new Error('--desde debe ser anterior a --hasta, y el rango de 24 meses como máximo.');
  }
  const vence = o.vence?.[0];
  if (vence && vence !== '12' && vence !== '20') throw new Error('--vence debe ser 12 o 20.');

  const clave = await leerClaveDelLlavero(rut);
  if (!clave) throw new Error(`No hay clave para ${rut} en el Llavero (servicio mcp-sii). Créala con: security add-generic-password -s mcp-sii -a <rut sin puntos ni guión> -w`);
  const credenciales = new ProveedorCredencialesRuntime();
  credenciales.guardar(rut, clave);
  const registro = crearRegistroSesionesSii(credenciales);

  try {
    const reporte = await verificarF29(registro, {
      rut, periodos,
      propuesta: o.propuesta ? periodoValido(o.propuesta[0], 'propuesta') : null,
      diaVencimiento: vence ? (Number(vence) as 12 | 20) : undefined,
      feriados: o.feriado ?? [],
    });
    const json = o.json?.[0];
    if (json === '-') {
      console.log(JSON.stringify(reporte, null, 2));
    } else {
      console.log(reporteEnTexto(reporte, { soloDiferencias: !o.todo }));
      if (json) writeFileSync(json, JSON.stringify(reporte, null, 2));
    }
    const hayErrores = reporte.verificaciones.some(v => v.hallazgos.some(h => h.severidad === 'error'))
      || reporte.declaracion.estado === 'no presentado';
    process.exitCode = hayErrores ? 1 : 0;
  } finally {
    await registro.cerrarYOlvidar(rut, s => s.logout());
    credenciales.borrar(rut);
  }
}

main().catch(e => { console.error('ERROR:', (e as Error).message); process.exit(2); });
