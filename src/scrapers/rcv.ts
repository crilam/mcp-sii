import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';

export type OperacionRcv = 'COMPRA' | 'VENTA';

// Una fila del resumen: un tipo de documento en el período.
export interface FilaResumenRcv {
  tipoDocCodigo: number;
  tipoDocNombre: string;
  documentos: number;
  montoNeto: number;
  montoExento: number;
  montoIva: number;
  montoTotal: number;
  // Las notas de crédito restan del total del período (ver TIPOS_NOTA_CREDITO).
  esNotaCredito: boolean;
}

export interface TotalesRcv {
  neto: number;
  exento: number;
  iva: number;
  total: number;
}

export interface ResumenRcv {
  empresaRut: string;
  periodo: string;
  operacion: OperacionRcv;
  // `true` cuando el SII respondió código 3: el período no tiene documentos
  // registrados. Es un vacío legítimo, no un fallo.
  sinDatos: boolean;
  // Mensaje del SII cuando lo hay. Sirve para distinguir un vacío de otro: un
  // período fuera del rango disponible viene con explicación ("debe ser mayor
  // igual a 201705"), un mes reciente sin actividad viene sin nada.
  mensaje: string | null;
  totalDocumentos: number;
  // Última actualización del registro según el SII (dcvFecModificacion).
  actualizadoAl: string | null;
  filas: FilaResumenRcv[];
  totales: TotalesRcv;
}

const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';

// Constante del portal (ESTADO_CONTAB_REGISTRO). Existen otros estados que no
// se relevaron, así que se manda siempre este.
const ESTADO_CONTAB = 'REGISTRO';

// Las notas de crédito **restan**: anulan o rebajan documentos ya emitidos. El
// SII las devuelve como una fila más, con montos positivos, exactamente igual
// que una factura — así que sumarlas junto al resto infla ventas e IVA y
// produce cifras que parecen plausibles y no lo son. Es un error que ya se
// cometió analizando estos datos.
//   61 = Nota de Crédito Electrónica
//   60 = Nota de Crédito (papel)
const TIPOS_NOTA_CREDITO = [61, 60];

// Códigos de respuesta de ESTA aplicación. No son los de renta: el RCV no usa
// `respCod`, trae su propio `respEstado.codRespuesta`, con otros valores.
// Cada uno se mapea explícitamente porque confundir dos de ellos falla en
// silencio: tratar el 3 como error reportaría un mes sin movimientos como una
// falla del servidor, y tratar el 2 como vacío escondería un error real detrás
// de un resumen en cero que se ve perfectamente normal.
const RESP_EXITO = 0;
const RESP_ERROR = 2;
const RESP_SIN_DATOS = 3;
const RESP_REDIRECCION = 98;

// La lista de códigos relevada en la spike (0, 3, 2, 98) NO era exhaustiva: el
// 99 apareció después, consultando un período anterior al que el registro tiene
// disponible, con `data: null` y un mensaje explícito ("Periodo consultado no
// válido, debe ser mayor igual a 201705").
//
// Se trata como vacío legítimo, no como error, porque describe un límite del
// registro y no una falla: la respuesta correcta a "¿qué documentos hay en
// 2015?" es "ninguno registrado", igual que un mes sin movimientos. El mensaje
// del SII se conserva en `mensaje` para que quede claro POR QUÉ vino vacío y no
// se confunda con un período reciente sin actividad.
const RESP_PERIODO_FUERA_DE_RANGO = 99;

const PERIODO_VALIDO = /^\d{4}(0[1-9]|1[0-2])$/;

export class RcvScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  // A diferencia de renta, acá la empresa es un parámetro del método
  // (rutEmisor/dvEmisor), no un estado de la sesión: no hay que seleccionar
  // empresa en ninguna pantalla y se puede consultar una empresa distinta en
  // cada llamada. Sin `empresaRut` se consulta el RUT autenticado.
  async resumen(
    periodo: string,
    operacion: OperacionRcv,
    empresaRut?: string
  ): Promise<ResumenRcv> {
    if (!PERIODO_VALIDO.test(periodo)) {
      throw new Error(
        `Período tributario inválido: "${periodo}". Se espera AAAAMM (por ejemplo 202607).`
      );
    }

    this.session.assertPuedeEntregarCookieJar();
    const { rut, dv } = empresaRut
      ? partirRut(empresaRut)
      : this.session.identidad();

    const resp = await this.http.postSdi(BASE, NAMESPACE, 'getResumen', {
      rutEmisor: rut,
      dvEmisor: dv,
      ptributario: periodo,
      estadoContab: ESTADO_CONTAB,
      operacion,
    });

    const base = {
      empresaRut: `${rut}-${dv}`,
      periodo,
      operacion,
      mensaje: resp?.respEstado?.msgeRespuesta ?? null,
    };

    if (!this.hayDatos(resp)) {
      return {
        ...base,
        sinDatos: true,
        totalDocumentos: 0,
        actualizadoAl: null,
        filas: [],
        totales: { neto: 0, exento: 0, iva: 0, total: 0 },
      };
    }

    const filas = (resp.data ?? []).map((f: any) => this.aFila(f));

    return {
      ...base,
      sinDatos: false,
      totalDocumentos: Number(resp.totDocRes ?? 0),
      actualizadoAl: resp.dataCabecera?.dcvFecModificacion ?? null,
      filas,
      totales: this.totalizar(filas),
    };
  }

  private aFila(f: any): FilaResumenRcv {
    const tipoDocCodigo = Number(f.rsmnTipoDocInteger);
    return {
      tipoDocCodigo,
      tipoDocNombre: (f.dcvNombreTipoDoc ?? '').trim(),
      documentos: Number(f.rsmnTotDoc ?? 0),
      montoNeto: Number(f.rsmnMntNeto ?? 0),
      montoExento: Number(f.rsmnMntExe ?? 0),
      montoIva: Number(f.rsmnMntIVA ?? 0),
      montoTotal: Number(f.rsmnMntTotal ?? 0),
      esNotaCredito: TIPOS_NOTA_CREDITO.includes(tipoDocCodigo),
    };
  }

  // Las notas de crédito entran con signo negativo: el SII las informa en
  // positivo, pero rebajan lo facturado. Ver TIPOS_NOTA_CREDITO.
  private totalizar(filas: FilaResumenRcv[]): TotalesRcv {
    return filas.reduce<TotalesRcv>((acc, f) => {
      const signo = f.esNotaCredito ? -1 : 1;
      return {
        neto: acc.neto + signo * f.montoNeto,
        exento: acc.exento + signo * f.montoExento,
        iva: acc.iva + signo * f.montoIva,
        total: acc.total + signo * f.montoTotal,
      };
    }, { neto: 0, exento: 0, iva: 0, total: 0 });
  }

  // `true` si la respuesta trae datos, `false` si es un vacío legítimo. Todo lo
  // demás lanza: un código desconocido no se puede reportar como "sin datos"
  // sin arriesgarse a esconder un fallo.
  private hayDatos(resp: any): boolean {
    // El sobre SDI mal armado devuelve "Acceso no autorizado!" y ni siquiera
    // llega a traer respEstado. El mensaje apunta a permisos, pero el problema
    // es de formato del sobre.
    if (resp?.errorMsg) {
      throw new Error(
        `El SII rechazó la consulta del Registro de Compras y Ventas: ${resp.errorMsg}. ` +
        'Si dice "Acceso no autorizado!", suele ser el sobre de la petición mal ' +
        'formado, no un problema de permisos.'
      );
    }

    const codigo = resp?.respEstado?.codRespuesta;
    const mensaje = resp?.respEstado?.msgeRespuesta;

    switch (codigo) {
      case RESP_EXITO:
        return true;
      case RESP_SIN_DATOS:
        // Vacío legítimo: el período no tiene documentos registrados. El portal
        // tampoco muestra error acá, simplemente no puebla la vista.
        return false;
      case RESP_PERIODO_FUERA_DE_RANGO:
        // También vacío legítimo, por otra razón: el período es anterior al que
        // el registro cubre (ver la constante). El `mensaje` del SII viaja en el
        // resultado para que el vacío se pueda explicar.
        return false;
      case RESP_ERROR:
        throw new Error(
          'El SII devolvió un error al consultar el Registro de Compras y Ventas' +
          (mensaje ? `: ${mensaje}` : '.')
        );
      case RESP_REDIRECCION:
        throw new Error(
          'El SII pide redirigir la consulta del Registro de Compras y Ventas ' +
          '(código 98). Suele indicar que la sesión ya no sirve para esta ' +
          'aplicación; reintentá.'
        );
      default:
        // Default seguro: lo desconocido FALLA, nunca cae en la rama de vacío.
        // La lista de códigos del SII ya demostró no ser exhaustiva (así
        // apareció el 99), así que cualquier condición nueva del servicio se
        // convertiría, si no, en "no hay datos" — un mes de movimientos podría
        // reportarse como vacío sin que nada avise. El código y el mensaje van
        // en el error para que el próximo desconocido se diagnostique en un
        // minuto: se mira la respuesta real y se decide si es vacío o error.
        throw new Error(
          `El SII devolvió un código de respuesta desconocido (${codigo}) al consultar ` +
          'el Registro de Compras y Ventas' +
          (mensaje ? `: ${mensaje}` : '') +
          '. No se reporta como período sin movimientos para no esconder un error real.'
        );
    }
  }
}

// El servicio quiere el RUT sin dígito verificador y el dv aparte. Acepta las
// dos formas que se usan en el proyecto ("22222222-2" y "222222222"), y también
// limpia los puntos por si el RUT llega escrito como en el portal.
export function partirRut(rutCompleto: string): { rut: string; dv: string } {
  const limpio = rutCompleto.replace(/\./g, '').trim();
  const [rut, dv] = limpio.includes('-')
    ? limpio.split('-')
    : [limpio.slice(0, -1), limpio.slice(-1)];

  if (!/^\d{5,9}$/.test(rut) || !/^[\dkK]$/.test(dv ?? '')) {
    throw new Error(`RUT de empresa inválido: "${rutCompleto}". Se espera 22222222-2.`);
  }

  return { rut, dv: dv.toUpperCase() };
}
