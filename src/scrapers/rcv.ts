import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { partirRut } from '../rut';

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
  // `true` si el tipo de documento no está en ninguna de las dos listas
  // conocidas: se sumó, pero su signo no está verificado (ver `totalizar`).
  tipoDesconocido: boolean;
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
  // `false` cuando el resumen trae algún tipo de documento cuyo signo no
  // conocemos: los totales se calcularon igual, pero pueden estar mal. Un total
  // silenciosamente mal es peor que un error, así que el consumidor tiene que
  // poder enterarse sin leer el código.
  totalesConfiables: boolean;
  // Los tipos de documento desconocidos que se encontraron, con su nombre según
  // el SII. Se listan para que resolverlo sea mirar esta salida y agregar el
  // código a la lista que corresponda, no salir a reproducir el caso.
  tiposDesconocidos: { codigo: number; nombre: string }[];
  // Advertencias en texto plano sobre la totalización. Vacío es lo normal.
  advertencias: string[];
}

// La contraparte de un documento cambia de rol según la operación: en COMPRA el
// otro es quien emitió (el proveedor), en VENTA es quien recibió (el cliente).
// Se nombra `contraparte` + `contraparteRol` —igual que en el scraper de boletas
// de honorarios— para no llamar "proveedor" a un cliente en una consulta de
// ventas, que es exactamente el tipo de etiqueta que después se lee mal.
export type RolContraparteRcv = 'emisor' | 'receptor';

// Qué clase de identificador es el de la contraparte.
//
//   'rut_chileno' → contraparteRut identifica de verdad a la contraparte.
//   'extranjero'  → contraparteRut trae el RUT genérico 55555555-5 y NO
//                   identifica a nadie; el identificador real está en
//                   contraparteIdExtranjero.
//
// Se eligió un discriminador explícito en vez de meter el identificador
// extranjero dentro de `contraparteRut`: un RUC ecuatoriano en un campo llamado
// "Rut" se lee como RUT chileno, se valida con módulo 11, se formatea con
// puntos y guion y se cruza contra otras fuentes chilenas — un problema
// cambiado por otro. Con el tipo explícito, quien consume sabe siempre qué
// tiene en la mano, y `contraparteRut` conserva literalmente lo que informa el
// SII (incluido el genérico) sin que nadie lo confunda con una identidad.
export type TipoIdContraparteRcv = 'rut_chileno' | 'extranjero';

// El SII usa este RUT genérico para TODO receptor extranjero: un comprador de
// otro país no tiene RUT chileno. Verificado contra una factura de exportación
// real (tipo 110). Es una constante pública, no un dato de nadie.
const RUT_GENERICO_EXTRANJERO = 55555555;
const DV_GENERICO_EXTRANJERO = '5';

// Una fila del detalle: UN documento del período, de un tipo de documento.
//
// La respuesta del SII trae más de 60 campos por fila. Acá se expone sólo el
// subconjunto que responde la pregunta del caso de uso —con quién, cuándo y por
// cuánto— más la referencia y el estado de aceptación. El resto son casos
// tributarios especiales (tabaco, pasajes nacionales/internacionales, depósito
// de envases, activo fijo, IVA de uso común, IVA no recuperable, retenciones
// totales/parciales, liquidaciones-factura, ley 18.211) que llegan casi siempre
// en 0 o null y que no se pueden interpretar sin verificarlos contra un caso
// real: exponerlos sin haberlos verificado invita a leerlos como si
// significaran algo. Cuando alguno haga falta, se agrega con su fixture.
export interface FilaDetalleRcv {
  // RUT de la contraparte con dígito verificador (formato 22222222-2), tal como
  // lo informa el SII. OJO: en documentos de exportación viene el genérico
  // 55555555-5 para cualquier extranjero, así que dos clientes distintos traen
  // el mismo valor. Ver contraparteTipoId antes de usarlo como identidad.
  contraparteRut: string;
  // Ver TipoIdContraparteRcv. Es el campo que hay que mirar para saber si
  // contraparteRut identifica a alguien.
  contraparteTipoId: TipoIdContraparteRcv;
  // Identificador de la contraparte en su país (detExpNumId): RUC, VAT, tax id
  // — el SII no dice cuál. `null` cuando el SII no lo informa, que es lo normal
  // fuera de exportaciones: si no viene, no se inventa nada.
  contraparteIdExtranjero: string | null;
  // Nacionalidad de la contraparte según el SII (detExpNacionalidad): es un
  // CÓDIGO NUMÉRICO de su tabla de países (218 = Ecuador), no un nombre. No se
  // traduce a nombre de país porque no tenemos la tabla y adivinar el país de
  // un cliente sería peor que exponer el código crudo. `null` si no viene.
  contraparteNacionalidadCodigo: number | null;
  contraparteNombre: string;
  // Qué es la contraparte respecto del documento: ver RolContraparteRcv.
  contraparteRol: RolContraparteRcv;
  folio: number;
  // Fecha de emisión tal como la informa el SII: DD/MM/AAAA. No se convierte a
  // ISO para no inventar zona horaria ni ocultar un formato inesperado.
  fechaEmision: string | null;
  montoNeto: number;
  montoExento: number;
  montoIva: number;
  montoTotal: number;
  // Documento referenciado. Es lo que hace útil el detalle en notas de crédito y
  // débito: dice QUÉ factura corrigen. `null` cuando el documento no referencia
  // nada — el SII usa 0 y null indistintamente para "sin referencia".
  referenciaTipoDoc: number | null;
  referenciaFolio: number | null;
  // Estado de aceptación o reclamo del receptor, en texto del SII. `null` es lo
  // habitual: significa que no hubo evento registrado, no que fue aceptado.
  eventoReceptor: string | null;
}

export interface DetalleRcv {
  empresaRut: string;
  periodo: string;
  operacion: OperacionRcv;
  // El tipo de documento consultado: el detalle SIEMPRE es por tipo, el SII no
  // devuelve el período entero de una vez.
  tipoDocCodigo: number;
  // Mismo criterio que en el resumen: vacío legítimo, no falla.
  sinDatos: boolean;
  mensaje: string | null;
  // Se cuenta lo que vino: el detalle no trae un total propio (no hay
  // `totDocRes` como en el resumen). Verificado contra el portal hasta 393
  // documentos —el tipo más grande disponible, las facturas electrónicas de
  // venta de julio—: el detalle devolvió las 393 y coincide exacto con el
  // resumen, y `metaData.page` viene `null`. Es una verificación hasta 393, NO
  // una garantía para cualquier tamaño: si algún día un período de miles de
  // documentos no cuadra con el resumen, la paginación es el primer lugar
  // donde mirar.
  totalDocumentos: number;
  documentos: FilaDetalleRcv[];
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
//   61  = Nota de Crédito Electrónica
//   60  = Nota de Crédito (papel)
//   112 = Nota de Crédito de Exportación Electrónica. No es hipotética: la
//         cuenta con la que se verificó esto emite facturas de exportación
//         (tipo 110), así que sus notas de crédito llegan como 112.
const TIPOS_NOTA_CREDITO = [61, 60, 112];

// Tipos de documento que se sabe que SUMAN. Existe por lo mismo que el default
// de `hayDatos`: el catálogo del SII es largo y no lo conocemos entero, así que
// un tipo que no está en ninguna de las dos listas no puede tratarse como si
// supiéramos su signo. Un tipo desconocido se suma —es lo más frecuente— pero
// **se reporta**: ver `totalizar` y `tiposDesconocidos`.
//
// La asimetría importa: si aparece una nota de crédito nueva y la sumamos en
// silencio, el total queda mal sin que nada avise, que es exactamente el modo de
// falla que este archivo viene evitando. Un total silenciosamente mal es peor
// que un error.
const TIPOS_QUE_SUMAN = [
  29,  // Factura de Inicio
  30,  // Factura
  32,  // Factura de venta exenta
  33,  // Factura Electrónica
  34,  // Factura no Afecta o Exenta Electrónica
  35,  // Boleta
  38,  // Boleta Exenta
  39,  // Boleta Electrónica
  40,  // Liquidación Factura
  41,  // Boleta Exenta Electrónica
  43,  // Liquidación Factura Electrónica
  45,  // Factura de Compra
  46,  // Factura de Compra Electrónica
  55,  // Nota de Débito
  56,  // Nota de Débito Electrónica (un débito SUMA, a diferencia del crédito)
  110, // Factura de Exportación Electrónica
  111, // Nota de Débito de Exportación Electrónica
  914, // Declaración de Ingreso (DIN)
];

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
      ? partirRut(empresaRut, 'RUT de empresa')
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
        totalesConfiables: true,
        tiposDesconocidos: [],
        advertencias: [],
      };
    }

    const filas = (resp.data as any[]).map(f => this.aFila(f));
    const tiposDesconocidos = filas
      .filter(f => f.tipoDesconocido)
      .map(f => ({ codigo: f.tipoDocCodigo, nombre: f.tipoDocNombre }));

    return {
      ...base,
      sinDatos: false,
      totalDocumentos: Number(resp.totDocRes ?? 0),
      actualizadoAl: resp.dataCabecera?.dcvFecModificacion ?? null,
      filas,
      totales: this.totalizar(filas),
      totalesConfiables: tiposDesconocidos.length === 0,
      tiposDesconocidos,
      advertencias: tiposDesconocidos.map(t =>
        `El tipo de documento ${t.codigo} ("${t.nombre}") no está en el catálogo conocido: ` +
        'se sumó a los totales, pero si es una nota de crédito debería restar. ' +
        'Revisá los totales antes de usarlos.'
      ),
    };
  }

  // Detalle documento por documento. A diferencia del resumen, el SII exige el
  // tipo de documento: no existe "el detalle del período entero", se pide un
  // tipo por vez. Los códigos son los que devuelve `resumen` en
  // `filas[].tipoDocCodigo`, así que el flujo natural es resumen → detalle del
  // tipo que interese.
  async detalle(
    periodo: string,
    operacion: OperacionRcv,
    tipoDocCodigo: number,
    empresaRut?: string
  ): Promise<DetalleRcv> {
    if (!PERIODO_VALIDO.test(periodo)) {
      throw new Error(
        `Período tributario inválido: "${periodo}". Se espera AAAAMM (por ejemplo 202607).`
      );
    }
    if (!Number.isInteger(tipoDocCodigo) || tipoDocCodigo <= 0) {
      throw new Error(
        `Código de tipo de documento inválido: "${tipoDocCodigo}". Se espera el código ` +
        'que devuelve sii_rcv_resumen en filas[].tipoDocCodigo (por ejemplo 33 o 61).'
      );
    }

    this.session.assertPuedeEntregarCookieJar();
    const { rut, dv } = empresaRut
      ? partirRut(empresaRut, 'RUT de empresa')
      : this.session.identidad();

    // El método cambia con la operación: el servicio no toma la operación como
    // discriminador acá, son dos endpoints distintos (igual se manda
    // `operacion`, que el portal envía siempre).
    const metodo = operacion === 'COMPRA' ? 'getDetalleCompra' : 'getDetalleVenta';

    const resp = await this.http.postSdi(BASE, NAMESPACE, metodo, {
      rutEmisor: rut,
      dvEmisor: dv,
      ptributario: periodo,
      codTipoDoc: String(tipoDocCodigo),
      operacion,
      estadoContab: ESTADO_CONTAB,
    });

    const base = {
      empresaRut: `${rut}-${dv}`,
      periodo,
      operacion,
      tipoDocCodigo,
      mensaje: resp?.respEstado?.msgeRespuesta ?? null,
    };

    // Misma lógica de códigos que el resumen, sin duplicar: 0 éxito, 3 y 99
    // vacío legítimo, 2 y 98 error, y lo desconocido falla citando el código.
    if (!this.hayDatos(resp)) {
      return { ...base, sinDatos: true, totalDocumentos: 0, documentos: [] };
    }

    const documentos = (resp.data as any[]).map(d =>
      this.aFilaDetalle(d, operacion)
    );

    return {
      ...base,
      sinDatos: false,
      totalDocumentos: documentos.length,
      documentos,
    };
  }

  private aFilaDetalle(d: any, operacion: OperacionRcv): FilaDetalleRcv {
    // En COMPRA el documento lo emitió el proveedor; en VENTA lo recibió el
    // cliente. En ambos casos los campos del SII son los mismos (detRutDoc /
    // detRznSoc apuntan siempre al otro), lo que cambia es qué significa.
    const contraparteRol: RolContraparteRcv =
      operacion === 'COMPRA' ? 'emisor' : 'receptor';

    // detExpNumId llega vacío, null o "" en todo lo que no sea exportación: se
    // normaliza a null para no exponer una cadena vacía que parezca un id.
    const idExtranjeroCrudo = String(d.detExpNumId ?? '').trim();
    const contraparteIdExtranjero = idExtranjeroCrudo === '' ? null : idExtranjeroCrudo;

    const nacionalidadCruda = String(d.detExpNacionalidad ?? '').trim();
    const contraparteNacionalidadCodigo =
      nacionalidadCruda === '' || Number.isNaN(Number(nacionalidadCruda))
        ? null
        : Number(nacionalidadCruda);

    // La contraparte es extranjera si el SII trajo su identificador de origen, o
    // si puso el RUT genérico de extranjero. Se miran las dos señales: el
    // genérico solo ya basta para saber que ese "RUT" no identifica a nadie,
    // aunque el identificador real no venga. Se exige el RUT genérico COMPLETO
    // (cuerpo y dígito verificador): 55555555 con otro DV es un RUT distinto,
    // de un contribuyente chileno cualquiera.
    const esExtranjera =
      contraparteIdExtranjero !== null ||
      (Number(d.detRutDoc) === RUT_GENERICO_EXTRANJERO &&
        String(d.detDvDoc ?? '').trim().toLowerCase() === DV_GENERICO_EXTRANJERO);

    return {
      contraparteRut: `${d.detRutDoc ?? ''}-${d.detDvDoc ?? ''}`,
      contraparteTipoId: esExtranjera ? 'extranjero' : 'rut_chileno',
      contraparteIdExtranjero,
      contraparteNacionalidadCodigo,
      contraparteNombre: (d.detRznSoc ?? '').trim(),
      contraparteRol,
      folio: Number(d.detNroDoc ?? 0),
      fechaEmision: d.detFchDoc ?? null,
      montoNeto: Number(d.detMntNeto ?? 0),
      montoExento: Number(d.detMntExe ?? 0),
      montoIva: Number(d.detMntIVA ?? 0),
      montoTotal: Number(d.detMntTotal ?? 0),
      // El SII usa 0 y null indistintamente para "sin documento referenciado";
      // se normalizan a null para que no parezca un folio o un tipo real.
      referenciaTipoDoc: d.detTipoDocRef ? Number(d.detTipoDocRef) : null,
      referenciaFolio: d.detFolioDocRef ? Number(d.detFolioDocRef) : null,
      eventoReceptor: d.detEventoReceptorLeyenda ?? null,
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
      tipoDesconocido:
        !TIPOS_NOTA_CREDITO.includes(tipoDocCodigo) &&
        !TIPOS_QUE_SUMAN.includes(tipoDocCodigo),
    };
  }

  // Las notas de crédito entran con signo negativo: el SII las informa en
  // positivo, pero rebajan lo facturado. Ver TIPOS_NOTA_CREDITO.
  //
  // Un tipo desconocido se suma, que es lo más frecuente, pero la fila queda
  // marcada y el resumen sale con `totalesConfiables: false`: no se puede
  // afirmar el signo de algo que no está en el catálogo, y afirmarlo en
  // silencio es cómo se produce un total que parece plausible y está mal.
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
        // Éxito sin datos es una contradicción del servicio, no un período
        // vacío: para eso están el 3 y el 99. Devolverlo como `sinDatos: false`
        // con `filas: []` dejaba un resumen que se contradice a sí mismo —cero
        // filas junto a un `totalDocumentos` que no es cero—, así que se falla.
        if (resp?.data == null) {
          throw new Error(
            'El SII respondió éxito (código 0) en el Registro de Compras y Ventas ' +
            'pero sin datos. Es una respuesta contradictoria: un período sin ' +
            'movimientos se informa con el código 3, no con el 0.'
          );
        }
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
