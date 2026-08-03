import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { partirRut } from '../rut';

// Consultas DTE (`consemitidosinternetui`) por HTTP directo.
//
// Antes esto vivía en `mipyme.ts`, sobre el navegador. El problema no era la
// fragilidad del parsing de snapshots sino el estado compartido: un solo Chrome
// con un solo almacén de cookies y la empresa seleccionada en una pantalla, o
// sea, ninguna forma de aislar identidades. Acá la empresa es un PARÁMETRO de
// cada llamada (`rutContribuyente`/`dvContribuyente`), así que dos consultas
// consecutivas pueden ser de empresas distintas sin ningún paso previo.
//
// NO se borró el camino de navegador: las tools `sii_mipyme_*` siguen usándolo.

export type OperacionDte = 'EMITIDOS' | 'RECIBIDOS';

// La contraparte cambia de rol según la operación, igual que en el RCV y en las
// boletas de honorarios. Ver `aFilaDetalle`: acá el nombre de los campos del SII
// miente, y este tipo es lo que impide propagar la mentira.
export type RolContraparteDte = 'emisor' | 'receptor';

// Una fila del resumen: un tipo de documento EN UNA SECCIÓN del período.
export interface FilaResumenDte {
  tipoDocCodigo: number;
  tipoDocNombre: string;
  // Parte de la clave, no un adorno: ver SECCIONES y `clave`.
  seccion: string;
  // Qué agrupa la sección, en texto. `null` si el SII manda una sección que no
  // está en la tabla relevada: se reporta el código crudo antes que inventar.
  seccionDescripcion: string | null;
  documentos: number;
  montoNeto: number;
  montoExento: number;
  montoIva: number;
  montoTotal: number;
  // `refNCD` y `totalDocNCD` son de la fila y hay que devolvérselos al SII tal
  // cual para pedir el detalle de ESTA fila (ver `detalleDeFila`). Sin ellos, la
  // segunda fila de un mismo tipo (el 61 de S2, por ejemplo) no se puede pedir.
  refNCD: number;
  documentosNotaCreditoDebito: number;
}

// Un documento del detalle.
export interface FilaDetalleDte {
  tipoDocCodigo: number;
  seccion: string;
  // RUT de la contraparte con dígito verificador (22222222-2).
  contraparteRut: string;
  contraparteNombre: string;
  // QUÉ es la contraparte respecto del documento. En emitidos es el receptor
  // (el cliente); en recibidos es el emisor (el proveedor). Los campos del SII
  // se llaman `*Receptor` en las dos operaciones, así que este campo es la única
  // forma de no llamar "receptor" al proveedor que nos emitió una factura.
  contraparteRol: RolContraparteDte;
  folio: number;
  // Fechas tal como las informa el SII: DD/MM/AAAA. No se convierten a ISO para
  // no inventar zona horaria ni ocultar un formato inesperado.
  fechaEmision: string | null;
  fechaRecepcion: string | null;
  montoNeto: number;
  montoExento: number;
  montoIva: number;
  montoTotal: number;
  // Tasa de IVA del documento según el SII (19.0). Viene por documento porque
  // hay tipos con tasa distinta o sin tasa.
  tasaIva: number | null;
  // Evento del receptor: `dehOrdenEvento` es un código del SII y
  // `dehDescripcion` su texto ("Acuse Recibo"). Descripción vacía se normaliza
  // a null: el SII manda "" cuando no hubo evento, y una cadena vacía en un
  // campo de estado se lee como si significara algo.
  eventoCodigo: string | null;
  eventoDescripcion: string | null;
  // Identificador interno del documento en la aplicación (`dhdrCodigo`). Es lo
  // que pide `getDetalleDTE` si algún día hace falta el detalle línea por línea.
  documentoCodigo: number | null;
}

export interface TotalesDte {
  neto: number;
  exento: number;
  iva: number;
  total: number;
}

export interface ListadoDte {
  empresaRut: string;
  periodo: string;
  operacion: OperacionDte;
  // Vacío legítimo: el período no tiene documentos. No es un error.
  sinDatos: boolean;
  mensaje: string | null;
  filas: FilaResumenDte[];
  documentos: FilaDetalleDte[];
  // Cuántos documentos coinciden con lo pedido (después del filtro por
  // contraparte, ANTES del `limit`). Si es mayor que `documentos.length`, la
  // lista viene recortada: ver `documentosTruncados`.
  totalDocumentos: number;
  // `true` cuando `limit` recortó la lista. Existe para que "10 documentos" no
  // se lea como "hay 10 documentos": `totalDocumentos` dice cuántos hay.
  documentosTruncados: boolean;
  // SUMA DE LOS DOCUMENTOS QUE COINCIDEN, no el total que declara el SII. Se
  // calcula sobre los `totalDocumentos`, no sobre la página recortada por
  // `limit`: totalizar sólo lo que se alcanzó a mostrar daría un total que
  // depende del tamaño de página. Ver `totalizar` y `totalesDeclarados`.
  totales: TotalesDte;
  // Los totales que declara el SII en `dataResp` (sumados si se pidió más de un
  // tipo). Se exponen porque el portal muestra estos, así que un usuario que
  // compare va a ver este número — pero NO cuadran con la suma de los
  // documentos: verificado en un período real, la suma de 393 documentos daba
  // 163.060.976 y el declarado decía 197.733.705. `totales` es el confiable.
  totalesDeclarados: TotalesDte | null;
  // `true` cuando `totales` y `totalesDeclarados` no coinciden, que es lo
  // habitual. Existe para que la discrepancia se pueda explicar sin que parezca
  // un bug del servidor.
  totalesDifierenDelDeclarado: boolean;
}

export interface DocumentoDte {
  empresaRut: string;
  periodo: string;
  operacion: OperacionDte;
  tipoDocCodigo: number;
  folio: number;
  // `false` cuando el folio no está en el período consultado. No es un error:
  // el documento puede ser de otro mes (el SII entrega el detalle por período).
  encontrado: boolean;
  mensaje: string | null;
  documento: FilaDetalleDte | null;
}

const BASE = 'https://www4.sii.cl/consemitidosinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consemitidos.data.api.interfaces.FacadeService';

// `operacion` es obligatorio en todos los métodos y es lo único que separa
// emitidos de recibidos en el resumen.
const OPERACION_EMITIDOS = 1;
const OPERACION_RECIBIDOS = 2;

// Las secciones que se relevaron contra el portal. Importan porque **la clave
// del resumen es `(tipoDoc, seccion)`, no `tipoDoc`**: el mismo tipo aparece dos
// veces con secciones distintas —el 61 llega como S1 y como S2— y agrupar sólo
// por tipo colapsa dos filas en una y suma mal.
const SECCIONES: Record<string, string> = {
  S1: 'Documentos afectos y exentos',
  S2: 'Facturas de compra y sus notas de crédito',
  S4: 'Exportación',
  S5: 'Guías de despacho',
};

// Códigos de respuesta de ESTA aplicación. NO son los del RCV, y la diferencia
// no es teórica: acá el 99 es "Usuario no autorizado" (`codError` cnsmtds.1.1.00)
// y en el RCV el mismo 99 es un período fuera del rango del registro, o sea un
// vacío legítimo. Una tabla de códigos compartida entre las dos aplicaciones
// habría reportado una falta de permisos como un mes sin movimientos.
const RESP_EXITO = 0;
const RESP_NO_AUTORIZADO = 99;

const PERIODO_VALIDO = /^\d{4}(0[1-9]|1[0-2])$/;

export class DteScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  // Resumen por (tipo, sección) + detalle documento por documento.
  //
  // El SII no entrega "el detalle del período entero" de una vez: el detalle es
  // por fila del resumen. Así que esto pide el resumen y después una llamada de
  // detalle por cada fila que corresponda. `tipoDocCodigo` acota a un tipo (y
  // `seccion`, a una sola fila) para no gastar llamadas cuando ya se sabe qué se
  // busca.
  //
  // `incluirDetalle` es OPT-IN, y el default importa: sin él, un listado sin
  // `tipoDocCodigo` dispara una consulta por fila del resumen (7 en el período
  // que se relevó). Con el límite de sesiones del SII y sin control de tasa
  // propio, eso se dispara sin querer. Lo costoso se pide explícitamente.
  async listar(
    periodo: string,
    operacion: OperacionDte,
    opciones: {
      empresaRut?: string;
      tipoDocCodigo?: number;
      seccion?: string;
      // `false` por defecto: sólo el resumen, una llamada.
      incluirDetalle?: boolean;
      // Filtros del lado del CLIENTE, sobre el detalle ya traído: el servicio
      // del SII no los recibe, así que no ahorran ninguna llamada. Se sostienen
      // igual porque preservan el contrato que tenían las tools con el
      // navegador y porque un tipo de documento puede traer cientos de filas.
      contraparteRut?: string;
      limit?: number;
    } = {}
  ): Promise<ListadoDte> {
    const { rut, dv } = this.identidadConsultada(opciones.empresaRut);
    const resumen = await this.resumenCrudo(periodo, operacion, rut, dv);

    const base = {
      empresaRut: `${rut}-${dv}`,
      periodo,
      operacion,
      mensaje: resumen.mensaje,
    };

    if (resumen.filas.length === 0) {
      return {
        ...base,
        sinDatos: true,
        filas: [],
        documentos: [],
        totalDocumentos: 0,
        documentosTruncados: false,
        totales: { neto: 0, exento: 0, iva: 0, total: 0 },
        totalesDeclarados: null,
        totalesDifierenDelDeclarado: false,
      };
    }

    const filas = resumen.filas.filter(f =>
      (opciones.tipoDocCodigo === undefined || f.tipoDocCodigo === opciones.tipoDocCodigo) &&
      (opciones.seccion === undefined || f.seccion === opciones.seccion)
    );

    // Default: sólo el resumen. Ver el comentario de `incluirDetalle`.
    if (opciones.incluirDetalle !== true) {
      return {
        ...base,
        sinDatos: false,
        filas,
        documentos: [],
        totalDocumentos: filas.reduce((n, f) => n + f.documentos, 0),
        documentosTruncados: false,
        // Sin detalle no hay documentos que sumar, y los montos del resumen son
        // otra cosa: no se rellena `totales` con algo que no se calculó.
        totales: { neto: 0, exento: 0, iva: 0, total: 0 },
        totalesDeclarados: null,
        totalesDifierenDelDeclarado: false,
      };
    }

    const todos: FilaDetalleDte[] = [];
    let declarados: TotalesDte | null = null;

    for (const fila of filas) {
      const det = await this.detalleDeFila(periodo, operacion, rut, dv, fila);
      todos.push(...det.documentos);
      if (det.declarados) {
        declarados = declarados
          ? {
              neto: declarados.neto + det.declarados.neto,
              exento: declarados.exento + det.declarados.exento,
              iva: declarados.iva + det.declarados.iva,
              total: declarados.total + det.declarados.total,
            }
          : det.declarados;
      }
    }

    // El filtro por contraparte se aplica acá, del lado del cliente: el
    // servicio no lo recibe. Se normaliza el RUT con `partirRut` para que
    // "22.222.222-2" y "222222222" coincidan con el "22222222-2" que armamos, en
    // vez de fallar por formato y devolver cero documentos —que se leería como
    // "esa contraparte no tiene documentos", el peor de los resultados.
    const coincidentes = opciones.contraparteRut
      ? (() => {
          const { rut: cRut, dv: cDv } = partirRut(
            opciones.contraparteRut,
            'RUT de contraparte'
          );
          const buscado = `${cRut}-${cDv}`;
          return todos.filter(d => d.contraparteRut.toUpperCase() === buscado);
        })()
      : todos;

    // Los totales se calculan sobre TODO lo que coincide, antes de recortar:
    // ver el comentario de `totales` en ListadoDte.
    const totales = this.totalizar(coincidentes);

    const limit = opciones.limit;
    const documentos =
      limit !== undefined && limit >= 0 ? coincidentes.slice(0, limit) : coincidentes;

    return {
      ...base,
      sinDatos: coincidentes.length === 0,
      filas,
      documentos,
      totalDocumentos: coincidentes.length,
      documentosTruncados: documentos.length < coincidentes.length,
      totales,
      // Con filtro por contraparte el declarado NO se expone: el SII lo calcula
      // sobre el período completo, así que junto a un subconjunto filtrado se
      // leería como el total de ese subconjunto. Un número que no significa lo
      // que parece es peor que ninguno.
      totalesDeclarados: opciones.contraparteRut ? null : declarados,
      totalesDifierenDelDeclarado:
        !opciones.contraparteRut &&
        declarados !== null &&
        (declarados.neto !== totales.neto ||
          declarados.exento !== totales.exento ||
          declarados.iva !== totales.iva ||
          declarados.total !== totales.total),
    };
  }

  // Un documento por tipo y folio. Se resuelve filtrando el detalle del
  // período: el SII no tiene "traeme el folio N", el detalle siempre viene por
  // (tipo, sección) de un período.
  //
  // Se recorren TODAS las filas del tipo, no la primera: un mismo tipo puede
  // estar en dos secciones y el folio buscado puede estar en cualquiera.
  async getDocumento(
    periodo: string,
    operacion: OperacionDte,
    tipoDocCodigo: number,
    folio: number,
    empresaRut?: string
  ): Promise<DocumentoDte> {
    if (!Number.isInteger(tipoDocCodigo) || tipoDocCodigo <= 0) {
      throw new Error(
        `Código de tipo de documento inválido: "${tipoDocCodigo}". Se espera el código que ` +
        'devuelve el listado en filas[].tipoDocCodigo (por ejemplo 33 o 61).'
      );
    }
    if (!Number.isInteger(folio) || folio <= 0) {
      throw new Error(`Folio inválido: "${folio}". Se espera un entero positivo.`);
    }

    const { rut, dv } = this.identidadConsultada(empresaRut);
    const resumen = await this.resumenCrudo(periodo, operacion, rut, dv);

    const base = {
      empresaRut: `${rut}-${dv}`,
      periodo,
      operacion,
      tipoDocCodigo,
      folio,
      mensaje: resumen.mensaje,
    };

    for (const fila of resumen.filas.filter(f => f.tipoDocCodigo === tipoDocCodigo)) {
      const det = await this.detalleDeFila(periodo, operacion, rut, dv, fila);
      const encontrado = det.documentos.find(d => d.folio === folio);
      if (encontrado) {
        return { ...base, encontrado: true, documento: encontrado };
      }
    }

    return { ...base, encontrado: false, documento: null };
  }

  // `getResumen`. Los nombres de campo son `rutContribuyente`/`dvContribuyente`:
  // ver `detalleDeFila`, donde el MISMO servicio los llama `rut`/`dv`.
  private async resumenCrudo(
    periodo: string,
    operacion: OperacionDte,
    rut: string,
    dv: string
  ): Promise<{ filas: FilaResumenDte[]; mensaje: string | null }> {
    const resp = await this.http.postSdi(BASE, NAMESPACE, 'getResumen', {
      periodo: this.periodoConGuion(periodo),
      rutContribuyente: rut,
      dvContribuyente: dv,
      operacion: this.codigoOperacion(operacion),
    });

    const mensaje = resp?.respEstado?.msgeRespuesta ?? null;
    if (!this.hayDatos(resp)) {
      return { filas: [], mensaje };
    }

    const crudas: any[] = resp?.data?.resumenDte ?? [];
    return { filas: crudas.map(f => this.aFilaResumen(f)), mensaje };
  }

  // `getDetalle` (emitidos) / `getDetalleRecibidos` (recibidos).
  //
  // DOS trampas del contrato, las dos verificadas contra el portal:
  //
  // 1. Acá los campos del contribuyente son `rut` y `dv`, NO
  //    `rutContribuyente`/`dvContribuyente` como en `getResumen`. Los dos
  //    métodos del mismo servicio usan nombres distintos para lo mismo; mandar
  //    el equivocado devuelve un 400 que nombra la clase Java y el campo
  //    rechazado.
  // 2. Los documentos vienen en `dataResp.detalles`, no en `data`, que llega
  //    `null`. Un parser que mire `data` ve un período vacío donde hay 393
  //    documentos.
  private async detalleDeFila(
    periodo: string,
    operacion: OperacionDte,
    rut: string,
    dv: string,
    fila: FilaResumenDte
  ): Promise<{ documentos: FilaDetalleDte[]; declarados: TotalesDte | null }> {
    const metodo = operacion === 'EMITIDOS' ? 'getDetalle' : 'getDetalleRecibidos';

    const resp = await this.http.postSdi(BASE, NAMESPACE, metodo, {
      tipoDoc: fila.tipoDocCodigo,
      rut,
      dv,
      periodo: this.periodoConGuion(periodo),
      operacion: this.codigoOperacion(operacion),
      // El portal manda `derrCodigo` con el mismo valor que `tipoDoc`.
      derrCodigo: fila.tipoDocCodigo,
      // Sale de la fila del resumen: es lo que distingue la fila S1 de la S2 de
      // un mismo tipo de documento.
      refNCD: fila.refNCD,
    });

    if (!this.hayDatos(resp)) {
      return { documentos: [], declarados: null };
    }

    const crudos: any[] = resp?.dataResp?.detalles ?? [];
    const dr = resp?.dataResp;

    return {
      documentos: crudos.map(d => this.aFilaDetalle(d, operacion, fila)),
      declarados: dr
        ? {
            neto: Number(dr.totMntNeto ?? 0),
            exento: Number(dr.totMntExe ?? 0),
            iva: Number(dr.totMntIVA ?? 0),
            total: Number(dr.totMntTotal ?? 0),
          }
        : null,
    };
  }

  private aFilaResumen(f: any): FilaResumenDte {
    const seccion = String(f.seccion ?? '').trim();
    return {
      tipoDocCodigo: Number(f.tipoDoc),
      tipoDocNombre: (f.tipoDocDesc ?? '').trim(),
      seccion,
      seccionDescripcion: SECCIONES[seccion] ?? null,
      documentos: Number(f.totalDoc ?? 0),
      montoNeto: Number(f.mntNeto ?? 0),
      montoExento: Number(f.mntExento ?? 0),
      montoIva: Number(f.mntIVA ?? 0),
      montoTotal: Number(f.mntTotal ?? 0),
      refNCD: Number(f.refNCD ?? 0),
      documentosNotaCreditoDebito: Number(f.totalDocNCD ?? 0),
    };
  }

  private aFilaDetalle(
    d: any,
    operacion: OperacionDte,
    fila: FilaResumenDte
  ): FilaDetalleDte {
    // LA TRAMPA: la contraparte viene SIEMPRE en los campos `*Receptor`, en las
    // dos operaciones. En recibidos, `rznSocRecep` trae al EMISOR —el proveedor
    // que nos emitió el documento—, y `rutEmisor`/`dvEmisor`/`rznSocEmisor`
    // llegan siempre null. Verificado con datos reales.
    //
    // Un parser que confíe en los nombres de campo etiqueta al proveedor como
    // "receptor" y produce una salida que se lee perfectamente bien y dice lo
    // contrario de lo que pasó. Por eso el rol se decide por la OPERACIÓN, que
    // es lo único que lo determina de verdad.
    const contraparteRol: RolContraparteDte =
      operacion === 'EMITIDOS' ? 'receptor' : 'emisor';

    const descripcion = String(d.dehDescripcion ?? '').trim();
    const evento = String(d.dehOrdenEvento ?? '').trim();

    return {
      tipoDocCodigo: fila.tipoDocCodigo,
      seccion: fila.seccion,
      contraparteRut: `${d.rutReceptor ?? ''}-${d.dvReceptor ?? ''}`,
      contraparteNombre: (d.rznSocRecep ?? '').trim(),
      contraparteRol,
      folio: Number(d.folio ?? 0),
      fechaEmision: d.fechaEmision ?? null,
      fechaRecepcion: d.fechaRecepcion ?? null,
      montoNeto: Number(d.mntNeto ?? 0),
      montoExento: Number(d.mntExento ?? 0),
      // OJO: acá el IVA es `mntIva` (i minúscula) y en el resumen es `mntIVA`.
      montoIva: Number(d.mntIva ?? 0),
      montoTotal: Number(d.mntTotal ?? 0),
      tasaIva: d.tasaImptoIVA == null ? null : Number(d.tasaImptoIVA),
      eventoCodigo: evento === '' ? null : evento,
      eventoDescripcion: descripcion === '' ? null : descripcion,
      documentoCodigo: d.dhdrCodigo == null ? null : Number(d.dhdrCodigo),
    };
  }

  // Se suman LAS FILAS, una por una. NO se usa `totMntNeto`/`totMntIVA`/
  // `totMntTotal` de `dataResp`, aunque parezcan el camino directo: no son el
  // mismo número. En un período real la suma de los 393 documentos dio
  // 163.060.976 y el total declarado decía 197.733.705 — una diferencia de 34
  // millones sin explicación relevada. La suma de los documentos es la que se
  // puede auditar contra el detalle que se está devolviendo; el declarado sale
  // en `totalesDeclarados` para que la diferencia sea visible en vez de
  // silenciosa. Hay un test que fija esto: no lo "arregles" usando el campo
  // declarado.
  private totalizar(documentos: FilaDetalleDte[]): TotalesDte {
    return documentos.reduce<TotalesDte>(
      (acc, d) => ({
        neto: acc.neto + d.montoNeto,
        exento: acc.exento + d.montoExento,
        iva: acc.iva + d.montoIva,
        total: acc.total + d.montoTotal,
      }),
      { neto: 0, exento: 0, iva: 0, total: 0 }
    );
  }

  private identidadConsultada(empresaRut?: string): { rut: string; dv: string } {
    this.session.assertPuedeEntregarCookieJar();
    // Sin `empresaRut` se consulta el RUT autenticado: ninguna tool exige
    // configurar una empresa por adelantado.
    return empresaRut
      ? partirRut(empresaRut, 'RUT de empresa')
      : this.session.identidad();
  }

  private codigoOperacion(operacion: OperacionDte): number {
    return operacion === 'EMITIDOS' ? OPERACION_EMITIDOS : OPERACION_RECIBIDOS;
  }

  // El período entra como AAAAMM (igual que en el resto del proyecto) y viaja
  // como AAAA-MM: el bundle del portal lo arma con guión y sin él la consulta
  // no devuelve nada. Se valida antes de convertir para que un período mal
  // escrito falle acá y no como un mes vacío del SII.
  private periodoConGuion(periodo: string): string {
    if (!PERIODO_VALIDO.test(periodo)) {
      throw new Error(
        `Período tributario inválido: "${periodo}". Se espera AAAAMM (por ejemplo 202607).`
      );
    }
    return `${periodo.slice(0, 4)}-${periodo.slice(4)}`;
  }

  // `true` si la respuesta trae datos, `false` si es un vacío legítimo. Todo lo
  // demás LANZA: mismo criterio que el RCV, con la tabla de códigos propia de
  // esta aplicación.
  private hayDatos(resp: any): boolean {
    // El sobre SDI mal armado devuelve "Acceso no autorizado!" sin llegar a
    // traer `respEstado`. El mensaje apunta a permisos, pero el problema es de
    // formato del sobre.
    if (resp?.errorMsg) {
      throw new Error(
        `El SII rechazó la consulta de Consultas DTE: ${resp.errorMsg}. ` +
        'Si dice "Acceso no autorizado!", suele ser el sobre de la petición mal ' +
        'formado, no un problema de permisos.'
      );
    }

    const codigo = resp?.respEstado?.codRespuesta;
    const mensaje = resp?.respEstado?.msgeRespuesta;
    const codError = resp?.respEstado?.codError;

    switch (codigo) {
      case RESP_EXITO: {
        // Éxito con las dos colecciones vacías o ausentes es un período sin
        // documentos, y eso es un vacío legítimo: esta aplicación no tiene un
        // código propio para "sin datos" como el 3 del RCV, informa el vacío
        // con un 0 y la lista vacía.
        const resumen = resp?.data?.resumenDte;
        const detalles = resp?.dataResp?.detalles;
        const hay =
          (Array.isArray(resumen) && resumen.length > 0) ||
          (Array.isArray(detalles) && detalles.length > 0);
        return hay;
      }
      case RESP_NO_AUTORIZADO:
        // 99 acá es "Usuario no autorizado" — un ERROR, no un vacío. En el RCV
        // el mismo número significa período fuera de rango, que sí es vacío.
        // Reportarlo como "no hay documentos" haría pasar una falta de permisos
        // por un mes sin movimientos.
        throw new Error(
          'El SII rechazó la consulta de Consultas DTE: usuario no autorizado ' +
          `(código 99${codError ? `, ${codError}` : ''})` +
          (mensaje ? `: ${mensaje}` : '.') +
          ' El certificado autenticado puede no tener permisos sobre la empresa consultada.'
        );
      default:
        // Default seguro: lo desconocido FALLA citando código y mensaje, nunca
        // cae en la rama de vacío. La lista de códigos del SII ya demostró no
        // ser exhaustiva en la otra aplicación, así que cualquier condición
        // nueva se convertiría, si no, en "no hay documentos" — un período con
        // movimientos reportado como vacío sin que nada avise.
        throw new Error(
          `El SII devolvió un código de respuesta desconocido (${codigo}) al consultar ` +
          'Consultas DTE' +
          (codError ? ` (${codError})` : '') +
          (mensaje ? `: ${mensaje}` : '') +
          '. No se reporta como período sin documentos para no esconder un error real.'
        );
    }
  }
}
