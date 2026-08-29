import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasBhe } from '../rest/rutas/bhe';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Busca un mes con MÁS de 100 boletas de honorarios recibidas.
//
// La paginación de recibidas ya está implementada encadenando
// `pagina_sig_codigo`, pero sin una captura real de un mes de más de una página:
// lo que la protege son los chequeos de integridad, no una verificación contra
// el portal. Este script existe para encontrar ese mes cuando haya una
// credencial con más movimiento y verificar el protocolo de verdad.
//
// El anual de recibidas NO trae conteo por mes, sólo montos: se usa el bruto
// como pista y se sondean los meses más altos con el mensual.
const NOMBRE = (process.argv[2] ?? 'mercado') as NombrePerfil;
const ANIOS = (process.env.BUSCAR_ANIOS ?? '2025,2026').split(',').map(Number);

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasBhe(rutas, registro, credenciales);
  const cred = credencialParaBody(p);

  console.log(`Perfil ${NOMBRE} (${p.rut})`);
  for (const anio of ANIOS) {
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const r = await rutas.get('POST /v1/bhe/resumen-recibidas')!({ ...cred, anio });
    const b = r.body as Record<string, unknown>;
    if (b.ok !== true) {
      console.log(`${anio}  FALLA ${b.error}: ${String(b.detalle ?? '').slice(0, 140)}`);
      continue;
    }
    // El anual no trae conteo, sólo montos. El bruto del mes es la pista: se
    // sondean los dos más altos con el mensual, que declara el total del mes
    // antes de cortar por la paginación.
    const meses = (b.meses ?? []) as { mes: number; honorarioBruto: number }[];
    console.log(`${anio}  ${meses.map(m => `${m.mes}:${Math.round(m.honorarioBruto / 1000)}k`).join(' ')}`);
    const top = [...meses].sort((a, c) => c.honorarioBruto - a.honorarioBruto).slice(0, 2)
      .filter(m => m.honorarioBruto > 0);
    for (const m of top) {
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const rm = await rutas.get('POST /v1/bhe/list-recibidas')!({ ...cred, anio, mes: m.mes });
      const bm = rm.body as Record<string, unknown>;
      const total = Array.isArray(bm.datos) ? bm.datos.length : undefined;
      console.log(`  ${anio}-${String(m.mes).padStart(2, '0')}  ok=${bm.ok} boletas=${total ?? '-'} `
        + `${bm.ok ? '' : `${bm.error}: ${String(bm.detalle ?? '').slice(0, 110)}`}`);
    }
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
