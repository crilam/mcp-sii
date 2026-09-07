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

    // Un FALLO del SII no puede terminar leyéndose como "no hay propuesta". Con
    // el namespace equivocado o la sesión caída, esta app responde HTTP 200 con
    // `metaData.errors` y `data` vacía: si eso cayera en el mismo camino que un
    // período sin propuesta, el consumidor recibiría "no reintentar" ante un
    // error que SÍ se arregla reintentando (o corrigiendo el namespace). Se
    // distingue acá, que es donde se tiene la respuesta cruda.
    const errores = respuesta?.metaData?.errors;
    if (errores) {
      const descripcion = Array.isArray(errores)
        ? errores.map((e: { descripcion?: string }) => e?.descripcion).filter(Boolean).join('; ')
        : '';
      throw new Error(
        `El SII rechazó la consulta de la propuesta del período ${periodo}` +
        `${descripcion ? `: ${descripcion}` : ''}.`);
    }
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
    const filas: FilaDeclaracion[] = Array.isArray(r?.data) ? r.data : [];
    // Se toma la primera con el mismo criterio que `f29.ts`: el SII ordena la
    // declaración vigente primero. OJO: con rectificatorias en el período puede
    // haber más de una fila, y esta fecha sería la de la que el SII puso
    // adelante, no necesariamente la vigente.
    return filas[0]?.declFechaCreacion ?? null;
  }
}
