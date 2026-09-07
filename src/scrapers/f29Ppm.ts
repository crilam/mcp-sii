import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { URL_ADAPTER, NS_ADAPTER, assertSinErrores } from './propuestaf29ui';

// Pago Provisional Mensual (PPM) del F29: la tasa que el SII aplica al período y
// los casilleros del cálculo.
//
// Es la cuarta fuente de la cuadratura del F29 —junto a compras, ventas y
// honorarios— y la única de las cuatro que no sale del Registro de Compras y
// Ventas: el SII la calcula con la renta del año anterior (§7 del relevamiento).
//
// Vive en la misma aplicación que la propuesta (`propuestaf29ui`, SDI, namespace
// `lob.iva`), así que comparte base, namespace y validación de errores.

// Los códigos del formulario que este endpoint entrega, en el orden en que el
// SII los nombra. Se listan explícitamente y no se deducen con un `/^cod/`: un
// campo nuevo del SII entraría solo a la respuesta sin que nadie lo revise, y
// `cod563Propuesto` y `cod115Original` empiezan igual pero NO son casilleros.
const CAMPOS_CASILLERO: [string, string][] = [
  ['cod750', '750'],
  ['cod30', '30'],
  ['cod563', '563'],
  ['cod115', '115'],
  ['cod68', '68'],
  ['cod62', '62'],
];

export interface CasilleroPpm {
  codigo: string;
  valor: string;
}

export interface TasaPpmF29 {
  // El período tal como lo devuelve el SII (AAAAMM). Se pasa el suyo y no el
  // pedido: si alguna vez no coinciden, quien consuma tiene que poder verlo.
  periodo: string | null;
  // Los códigos que el SII trae poblados, con el valor como STRING y sin
  // normalizar — misma decisión que en la propuesta: la tasa del 115 viene
  // "0.125" y cualquier conversión a entero la rompe.
  casilleros: CasilleroPpm[];
  // El 563 PROPUESTO por el SII. En un período abierto es igual al `cod563`; en
  // uno ya declarado con otro valor, la diferencia es justo el dato accionable.
  cod563Propuesto: string | null;
  // Tasa del Impuesto de Primera Categoría con la que el SII calculó ("27.0").
  tasaIdpc: string | null;
  categoriaTributaria: number | null;
  // `true` cuando el contribuyente YA usó el asistente de PPM en el período. En
  // un período abierto y sin tocar viene `false`, y entonces el `cod563` es una
  // PROPUESTA, no un valor declarado.
  realizado: boolean;
  fueraDePlazo: boolean;
  esPropyme: boolean;
}

interface RespuestaTasaPpm {
  cod563Propuesto?: string | null;
  tasaIDPC?: string | null;
  categoriaTributaria?: number | null;
  realizado?: boolean | null;
  fueraDePlazo?: boolean | null;
  esPropyme?: boolean | null;
  periodo?: string | null;
  [campo: string]: unknown;
}

export class F29PpmScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  /**
   * Tasa y casilleros de PPM del período. `periodo` es AAAAMM.
   *
   * Una sola consulta al SII. `categoriaTributaria: 1` es lo que manda la app
   * del portal; el endpoint devuelve la categoría real del contribuyente en la
   * respuesta, así que el valor del payload no la decide.
   */
  async tasaPpm(periodo: string): Promise<TasaPpmF29> {
    const { rut, dv } = this.session.identidad();
    const anno = periodo.slice(0, 4);
    const mes = periodo.slice(4);

    const respuesta = await this.http.postSdi(
      URL_ADAPTER, NS_ADAPTER, 'getTasaPPMO',
      // `mes` y `anno` van como STRING aunque el SII los devuelva como number:
      // así se verificó contra el SII real. El resto de los campos del payload
      // que usa el portal son opcionales.
      { rutContribuyente: String(rut), dv: String(dv), mes, anno, categoriaTributaria: 1 }
    );

    assertSinErrores(respuesta, `la tasa de PPM del período ${periodo}`);
    if (respuesta?.data == null) {
      throw new Error(
        `El SII no devolvió datos de PPM del período ${periodo}.`);
    }
    const datos: RespuestaTasaPpm = respuesta.data;

    const casilleros: CasilleroPpm[] = [];
    for (const [campo, codigo] of CAMPOS_CASILLERO) {
      const valor = datos[campo];
      // Se descartan `null` Y `''`: el SII usa los dos para "este código no
      // aplica", y un casillero con valor vacío no es un dato.
      if (valor === null || valor === undefined || valor === '') continue;
      casilleros.push({ codigo, valor: String(valor) });
    }

    return {
      periodo: datos.periodo ?? null,
      casilleros,
      cod563Propuesto: datos.cod563Propuesto == null ? null : String(datos.cod563Propuesto),
      tasaIdpc: datos.tasaIDPC == null ? null : String(datos.tasaIDPC),
      categoriaTributaria: typeof datos.categoriaTributaria === 'number' ? datos.categoriaTributaria : null,
      // Los tres booleanos se comparan contra `true` en vez de castear: un
      // `null` del SII pasaría como `false` de todas formas, pero un `"S"`
      // —que esta misma app usa en otros campos— sería truthy y mentiría.
      realizado: datos.realizado === true,
      fueraDePlazo: datos.fueraDePlazo === true,
      esPropyme: datos.esPropyme === true,
    };
  }
}
