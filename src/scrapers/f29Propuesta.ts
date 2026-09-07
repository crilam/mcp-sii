import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';

// Propuesta del F29: los casilleros que el SII propone para un período a partir
// del Registro de Compras y Ventas.
//
// Vive en OTRA aplicación que el estado de la declaración (`f29.ts`, que habla
// GWT-RPC contra `sifmConsultaInternet`): ésta es `propuestaf29ui`, una app SDI
// normal, así que va por el mismo sobre `postSdi` que el RCV.
//
// Relevada el 2026-09-06:
// docs/relevamientos/2026-09-06-f29-propuesta-y-asistentes.md
//
// OJO CON EL NAMESPACE: es `lob.iva`, no `lob.diii` como el resto del repo. Si
// se equivoca, el SII responde 200 con `metaData.errors` diciendo cuál es el
// correcto — pero el resultado viene vacío, que es peor que un error duro.
const BASE = 'https://www4.sii.cl/propuestaf29ui/services/data';
const NS = 'cl.sii.sdi.lob.iva.propuestaf29.data.api.interfaces';

const URL_ADAPTER = `${BASE}/facadeAdapterService`;
const NS_ADAPTER = `${NS}.FacadeAdapterService`;

// El F29 es el formulario 2 en el catálogo interno del SII (no 29: 29 es su
// nombre público). Sale de la captura del formulario real.
const FORM_CODIGO = '2';
const FORM_ID = '2';

// Un casillero del formulario tal como lo propone el SII. `valor` es STRING y no
// número a propósito: así lo manda el SII —incluida la tasa, `"0.125"`— y
// convertirlo acá obligaría a decidir por el consumidor si un monto es entero o
// decimal. Se entrega crudo.
export interface CasilleroPropuesto {
  codigo: string;
  valor: string;
}

export interface PropuestaF29 {
  // `null` cuando el SII no arma propuesta para el período.
  casilleros: CasilleroPropuesto[] | null;
  // Entero del SII. NO es un enum de este repo: se pasa tal cual (se han visto
  // valores como 40), y `tipopropuestadescrip` viene null en todos los casos
  // medidos.
  tipoPropuesta: number | null;
  // Fecha de creación de la DECLARACIÓN, si el período ya fue declarado. No sale
  // de la propuesta —que no la trae— sino de `getDeclaracionConEstados`.
  fechaCreacion: string | null;
  complementoDetalleDTE: boolean;
  documentosDelGiro: boolean;
}

interface RespuestaPropuesta {
  listCodPropuestos?: { codigo: string; valor: string }[] | null;
  tipopropuesta?: number | null;
  complementoDetalleDTE?: boolean;
  documentosDelGiro?: boolean;
}

interface FilaDeclaracion {
  declFechaCreacion?: string | null;
  estado?: string | null;
}

/**
 * Lanza si el sobre SDI trae errores. Va acá y no en cada llamada porque el modo
 * de fallo de esta app es traicionero: responde HTTP 200 con `metaData.errors` y
 * `data` vacía, así que un error no verificado se lee como "no hay dato".
 *
 * Mira el CONTENIDO de `errors` y no su presencia: `errors: []` es truthy, y
 * verificar la existencia haría fallar toda consulta exitosa que traiga la lista
 * vacía.
 */
function assertSinErrores(respuesta: { metaData?: { errors?: unknown } } | null, queSePedia: string): void {
  const errores = respuesta?.metaData?.errors;
  const hayError = Array.isArray(errores) ? errores.length > 0 : errores != null;
  if (!hayError) return;

  // El texto del SII se ACOTA antes de entrar al mensaje. Este error termina en
  // `console.error` (ver `rest/rutas/comun.ts`), y `errors[].descripcion` es texto
  // libre de una aplicación que en otros campos manda RUT y razón social: un día
  // trae uno y queda en los logs. Se corta a lo que alcanza para diagnosticar.
  const crudo = Array.isArray(errores)
    ? errores.map((e: { descripcion?: string }) => e?.descripcion).filter(Boolean).join('; ')
    // Si no es un array, se serializa igual: perder toda pista del fallo deja al
    // operador sin nada que mirar.
    : JSON.stringify(errores);
  const descripcion = (crudo ?? '').slice(0, 200);
  throw new Error(
    `El SII rechazó la consulta de ${queSePedia}${descripcion ? `: ${descripcion}` : ''}.`);
}

export class F29PropuestaScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  /**
   * Propuesta del período. `periodo` es AAAAMM.
   *
   * Hace DOS consultas: la propuesta y el estado de la declaración. La segunda
   * existe sólo para `fechaCreacion`, que la propuesta NO trae — es de la
   * declaración, no de la propuesta. Van en serie y no en paralelo: el SII
   * limita sesiones simultáneas por RUT, y dos peticiones concurrentes del mismo
   * contribuyente es justo el patrón que penaliza.
   */
  async propuesta(periodo: string): Promise<PropuestaF29> {
    const { rut, dv } = this.session.identidad();
    const anno = periodo.slice(0, 4);
    const mes = periodo.slice(4);

    const respuesta = await this.http.postSdi(
      URL_ADAPTER, NS_ADAPTER, 'getDeclaracionConCondicionesYTipoPropuesta',
      { rutContribuyente: String(rut), dv: String(dv), formCodigo: FORM_CODIGO, mes, anno }
    );

    assertSinErrores(respuesta, `la propuesta del período ${periodo}`);
    if (respuesta?.data == null) {
      throw new Error(
        `El SII no devolvió datos de la propuesta del período ${periodo}. ` +
        'No es lo mismo que un período sin propuesta: acá no vino ni el envoltorio.');
    }
    const datos: RespuestaPropuesta = respuesta.data;

    // ACÁ SÍ: `data` llegó bien y no trae códigos. Es un período sin propuesta,
    // un resultado LEGÍTIMO que quien llama distingue por `casilleros: null`.
    const lista = datos.listCodPropuestos;
    const casilleros = Array.isArray(lista) && lista.length > 0
      ? lista.map(c => ({ codigo: String(c.codigo), valor: String(c.valor) }))
      : null;

    return {
      casilleros,
      tipoPropuesta: datos.tipopropuesta ?? null,
      // Sin propuesta no se pregunta la fecha: sería una segunda llamada al SII
      // para un dato que el consumidor no va a usar, y el SII penaliza volumen.
      fechaCreacion: casilleros === null
        ? null
        : await this.fechaCreacion(String(rut), String(dv), mes, anno),
      // El default es `false` y no `true`: si el SII no lo declara, no se puede
      // afirmar que el detalle venga del RCV.
      complementoDetalleDTE: datos.complementoDetalleDTE === true,
      documentosDelGiro: datos.documentosDelGiro === true,
    };
  }

  // Fecha de creación de la declaración vigente, si existe. Un período sin
  // declarar devuelve lista vacía, que acá es `null` — no es un error.
  private async fechaCreacion(
    rut: string, dv: string, mes: string, anno: string
  ): Promise<string | null> {
    const r = await this.http.postSdi(
      URL_ADAPTER, NS_ADAPTER, 'getDeclaracionConEstados',
      { rut, dv, formId: FORM_ID, mes, anno }
    );
    // Esta consulta se valida igual que la primera. Sin esto, un fallo del SII
    // acá —sesión caída a mitad de camino, por ejemplo— dejaba `filas` en `[]` y
    // la fecha en `null`, que el consumidor lee como "el período no está
    // declarado". Un error disfrazado de dato, otra vez.
    assertSinErrores(r, `el estado de la declaración de ${anno}${mes}`);

    const filas: FilaDeclaracion[] = Array.isArray(r?.data) ? r.data : [];
    // Se busca la VIGENTE explícitamente en vez de confiar en que el SII la
    // ordene primero: con rectificatorias hay más de una fila, y "la primera"
    // es una convención del portal que nadie nos garantiza. Si ninguna se
    // declara vigente, se cae a la primera antes que devolver null.
    // La expresión va ANCLADA: `/vigente/i` también matchea "No Vigente", que es
    // como el SII marca las declaraciones reemplazadas por una rectificatoria. Con
    // esa fila delante, la fecha devuelta sería la de la declaración vieja — un
    // dato equivocado y silencioso, justo lo que este archivo se esfuerza en
    // evitar en todos lados.
    const vigente = filas.find(f => /^\s*vigente\s*$/i.test(f.estado ?? ''));
    if (vigente) return vigente.declFechaCreacion ?? null;

    // Ninguna se declara vigente. Con UNA sola fila no hay ambigüedad y se usa;
    // con varias no se adivina: devolver la fecha de una declaración anulada como
    // si fuera la del período es peor que no devolver nada.
    return filas.length === 1 ? filas[0].declFechaCreacion ?? null : null;
  }
}
