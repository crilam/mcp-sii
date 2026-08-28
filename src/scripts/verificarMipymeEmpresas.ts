import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';

// ¿La credencial del .env tiene empresas habilitadas en el portal mipyme?
//
// Es la pregunta que decide si la ronda de mipyme se puede relevar con esta
// credencial: el portal de Facturación Gratuita sólo lista las empresas que el
// RUT tiene INSCRITAS ahí, y no todo contribuyente lo está. Se pregunta por el
// handler REST y no por el scraper, que es el camino de producción.
async function main() {
  const rut = process.env.SII_EMPRESA_RUT ?? process.env.SII_RUT;
  const clave = process.env.SII_EMPRESA_CLAVE ?? process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_EMPRESA_RUT / SII_EMPRESA_CLAVE en el .env.');

  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);

  const r = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut, clave });
  const b = r.body as Record<string, unknown>;

  console.log(`RUT consultado: ${rut}`);
  console.log(JSON.stringify(b, null, 2).slice(0, 2000));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
