import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { partirRut } from '../rut';
import { LimitacionConocida } from '../erroresConsulta';

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
  // OJO CON ESTOS CUATRO: son montos DECLARADOS POR EL SII, la misma clase de
  // número que `ListadoDte.totalesDeclarados` — y por lo tanto NO cuadran con la
  // suma de los documentos del detalle. Llevan el sufijo en el nombre porque el
  // camino por defecto (sin detalle) devuelve estas filas como lo único con
  // montos, y con un nombre neutro se leen como auditables: sumarlas produce una
  // cifra plausible que no se puede reconciliar con ningún documento. Si hacen
  // falta montos auditables, hay que pedir el detalle y usar `totales`.
  montoNetoDeclarado: number;
  montoExentoDeclarado: number;
  montoIvaDeclarado: number;
  montoTotalDeclarado: number;
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

// Los tres estados del detalle. Era un booleano y no alcanzaba: con el resumen
// vacío devolvía `false`, que significa "no se pidió" —lo contrario de lo que
// había pasado— y sólo se desambiguaba correlacionando con `sinDatos`, que es
// justo lo que el campo venía a evitar. Ahora los tres se distinguen solos:
//
//   'no_pedido'            → no se pidió el detalle. Los documentos pueden
//                            existir y no se trajeron: `documentos` vacío NO
//                            significa que no haya nada.
//   'incluido'             → se pidió y se trajo. `documentos` vacío acá sí
//                            significa que no hay documentos.
//   'sin_filas_que_pedir'  → se pidió, pero el resumen no tenía ninguna fila en
//                            el alcance consultado, así que no había ningún
//                            detalle que pedirle al SII.
export type EstadoDetalle = 'no_pedido' | 'incluido' | 'sin_filas_que_pedir';

// De dónde salen los montos que trae la respuesta. Es el campo que evita el
// peor malentendido de la migración: en el camino por defecto lo único con
// montos son las filas del resumen, que son DECLARADOS por el SII y no cuadran
// con ningún documento.
//
//   'declarados_por_el_sii' → sólo hay montos declarados (filas[].monto*Declarado
//                             y, si vino, totalesDeclarados). NO son auditables
//                             contra los documentos.
//   'suma_de_documentos'    → `totales` está calculado sumando los documentos
//                             traídos, y es el número que se puede auditar.
//   'sin_montos'            → no hay montos en la respuesta.
export type OrigenDeMontos = 'declarados_por_el_sii' | 'suma_de_documentos' | 'sin_montos';

// QUÉ SE PIDIÓ, literalmente. Se devuelve porque los campos de resultado se leen
// distinto según el alcance —un `sinDatos` de un tipo puntual no dice nada del
// período— y porque un filtro que quedó aplicado o no es exactamente el tipo de
// cosa que no puede quedar implícita.
export interface AlcanceConsultaDte {
  tipoDocCodigo: number | null;
  seccion: string | null;
  contraparteRut: string | null;
  limit: number | null;
  detallePedido: boolean;
}

export interface ListadoDte {
  empresaRut: string;
  periodo: string;
  operacion: OperacionDte;
  alcance: AlcanceConsultaDte;
  // `true` cuando el alcance consultado no tiene documentos: un vacío legítimo,
  // no un error.
  //
  // Se mide ANTES del filtro por contraparte, y se calcula igual con detalle y
  // sin él (con detalle, contando los documentos traídos; sin detalle, sumando
  // lo que declaran las filas). Las dos cosas son deliberadas:
  //
  //   - Antes del filtro, porque "el proveedor que busqué no aparece" NO es "la
  //     empresa no tuvo movimientos": con el RUT mal escrito, un mes de 393
  //     documentos se leía como un mes vacío. Eso vive en
  //     `filtroContraparteSinCoincidencias`.
  //   - Igual en los dos modos, porque si no la MISMA pregunta daba dos
  //     respuestas: con tipo_doc inexistente, sin detalle decía `false` y con
  //     detalle decía `true`.
  sinDatos: boolean;
  // `true` cuando se pidió un `contraparteRut` y ningún documento del alcance es
  // de esa contraparte. Distinto de `sinDatos`: acá el período SÍ tiene
  // documentos. `null` cuando no se filtró por contraparte.
  filtroContraparteSinCoincidencias: boolean | null;
  mensaje: string | null;
  // OJO: los montos de las filas son DECLARADOS por el SII. Ver
  // FilaResumenDte y `origenDeMontos`.
  filas: FilaResumenDte[];
  estadoDetalle: EstadoDetalle;
  documentos: FilaDetalleDte[];
  // Cuántos documentos coinciden con lo pedido (después del filtro por
  // contraparte, ANTES del `limit`). Si es mayor que `documentos.length`, la
  // lista viene recortada: ver `documentosTruncados`. Sin detalle es lo que
  // declaran las filas del resumen.
  totalDocumentos: number;
  // `true` cuando `limit` recortó la lista. Existe para que "10 documentos" no
  // se lea como "hay 10 documentos": `totalDocumentos` dice cuántos hay.
  documentosTruncados: boolean;
  // De dónde salen los montos de esta respuesta. Ver OrigenDeMontos.
  origenDeMontos: OrigenDeMontos;
  // SUMA DE LOS DOCUMENTOS QUE COINCIDEN, no el total que declara el SII. Se
  // calcula sobre los `totalDocumentos`, no sobre la página recortada por
  // `limit`: totalizar sólo lo que se alcanzó a mostrar daría un total que
  // depende del tamaño de página. Ver `totalizar` y `totalesDeclarados`.
  //
  // `null` —NO ceros— cuando no se trajo el detalle: no hay nada que sumar, y un
  // cero se lee como "cero pesos en el período", que es una afirmación sobre los
  // datos que no se hizo ninguna consulta para sostener.
  totales: TotalesDte | null;
  // Los totales que declara el SII en `dataResp` (sumados si se pidió más de un
  // tipo). Se exponen porque el portal muestra estos, así que un usuario que
  // compare va a ver este número — pero NO cuadran con la suma de los
  // documentos: verificado en un período real, la suma de 393 documentos daba
  // 163.060.976 y el declarado decía 197.733.705. `totales` es el confiable.
  totalesDeclarados: TotalesDte | null;
  // `true` cuando `totales` y `totalesDeclarados` no coinciden, que es lo
  // habitual. Existe para que la discrepancia se pueda explicar sin que parezca
  // un bug del servidor. `false` cuando no hay con qué comparar.
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
    const detallePedido = opciones.incluirDetalle === true;

    // Los filtros del lado del cliente operan sobre el detalle: sin detalle no
    // hay nada que filtrar. Antes se ignoraban en silencio y la respuesta era el
    // resumen COMPLETO del período — que el consumidor atribuía a la contraparte
    // que había pedido. Se falla en vez de devolver otra cosa parecida.
    // LimitacionConocida y no Error pelado: `ejecutar` mapea el Error genérico a
    // ERROR, que es el único código que el contrato REST declara reintentable, y
    // esto es determinístico — el mismo request falla igual siempre. Un
    // consumidor que respete el contrato reintentaría para siempre.
    if (!detallePedido && (opciones.contraparteRut !== undefined || opciones.limit !== undefined)) {
      throw new LimitacionConocida(
        'Los filtros contraparteRut y limit se aplican sobre el detalle, así que requieren ' +
        'incluirDetalle=true. Sin detalle la respuesta sería el resumen completo del período, ' +
        'no lo filtrado: se falla para no devolver un resultado que se lee como si el filtro ' +
        'se hubiera aplicado.'
      );
    }

    // `limit: 0` devolvía una lista vacía con `documentosTruncados: true`, que se
    // lee como "hay documentos y no te muestro ninguno". No es un pedido con
    // sentido: se rechaza.
    if (opciones.limit !== undefined && (!Number.isInteger(opciones.limit) || opciones.limit < 1)) {
      throw new Error(
        `Límite inválido: "${opciones.limit}". Se espera un entero mayor o igual a 1.`
      );
    }

    // El RUT de la contraparte se normaliza ACÁ, antes de cualquier consulta: un
    // RUT mal escrito tiene que fallar y no devolver cero documentos, que se
    // leería como "esa contraparte no tiene documentos".
    const contraparteBuscada = opciones.contraparteRut
      ? (() => {
          const { rut, dv } = partirRut(opciones.contraparteRut, 'RUT de contraparte');
          return `${rut}-${dv}`;
        })()
      : null;

    const { rut, dv } = this.identidadConsultada(opciones.empresaRut);
    const resumen = await this.resumenCrudo(periodo, operacion, rut, dv);

    // QUÉ SE PIDIÓ, explícito en la respuesta: los demás campos se leen distinto
    // según el alcance.
    const alcance: AlcanceConsultaDte = {
      tipoDocCodigo: opciones.tipoDocCodigo ?? null,
      seccion: opciones.seccion ?? null,
      contraparteRut: contraparteBuscada,
      limit: opciones.limit ?? null,
      detallePedido,
    };

    const base = {
      empresaRut: `${rut}-${dv}`,
      periodo,
      operacion,
      alcance,
      mensaje: resumen.mensaje,
    };

    const filas = resumen.filas.filter(f =>
      (opciones.tipoDocCodigo === undefined || f.tipoDocCodigo === opciones.tipoDocCodigo) &&
      (opciones.seccion === undefined || f.seccion === opciones.seccion)
    );

    // Sin filas en el alcance no hay documentos y no hay ningún detalle que
    // pedirle al SII. La MISMA respuesta se da con detalle y sin él: antes, un
    // tipo inexistente decía `sinDatos: false` sin detalle y `true` con detalle,
    // o sea la misma pregunta con dos respuestas contradictorias.
    if (filas.length === 0) {
      return {
        ...base,
        sinDatos: true,
        // No se filtró nada porque no había nada: afirmar que el filtro no
        // coincidió sería otra explicación del vacío, y la explicación es que el
        // alcance está vacío.
        filtroContraparteSinCoincidencias: null,
        filas: [],
        estadoDetalle: detallePedido ? 'sin_filas_que_pedir' : 'no_pedido',
        documentos: [],
        totalDocumentos: 0,
        documentosTruncados: false,
        origenDeMontos: 'sin_montos',
        totales: null,
        totalesDeclarados: null,
        totalesDifierenDelDeclarado: false,
      };
    }

    // Default: sólo el resumen. Ver el comentario de `incluirDetalle`.
    if (!detallePedido) {
      const declaradosPorFilas = filas.reduce((n, f) => n + f.documentos, 0);
      return {
        ...base,
        // Mismo criterio que con detalle: no hay documentos en el alcance. Acá se
        // mide con lo que declaran las filas, que es lo único que se consultó.
        sinDatos: declaradosPorFilas === 0,
        filtroContraparteSinCoincidencias: null,
        filas,
        estadoDetalle: 'no_pedido',
        documentos: [],
        totalDocumentos: declaradosPorFilas,
        documentosTruncados: false,
        // Lo único con montos son las filas, y son DECLARADOS por el SII: la
        // misma clase de número que `totalesDeclarados`, que no cuadra con la
        // suma de los documentos. Queda dicho en el dato, no sólo en la prosa.
        origenDeMontos: 'declarados_por_el_sii',
        // `null`, no ceros: sin detalle no se sumó nada, y un cero se lee como
        // "cero pesos en el período".
        totales: null,
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

    // El filtro por contraparte se aplica acá, del lado del cliente: el servicio
    // no lo recibe.
    const coincidentes = contraparteBuscada
      ? todos.filter(d => d.contraparteRut.toUpperCase() === contraparteBuscada)
      : todos;

    // Los totales se calculan sobre TODO lo que coincide, antes de recortar: ver
    // el comentario de `totales` en ListadoDte.
    const totales = this.totalizar(coincidentes);

    const documentos =
      opciones.limit !== undefined ? coincidentes.slice(0, opciones.limit) : coincidentes;

    return {
      ...base,
      // Se mide ANTES del filtro por contraparte: "el proveedor que busqué no
      // aparece" no es "la empresa no tuvo movimientos".
      sinDatos: todos.length === 0,
      filtroContraparteSinCoincidencias: contraparteBuscada
        ? coincidentes.length === 0 && todos.length > 0
        : null,
      filas,
      estadoDetalle: 'incluido',
      documentos,
      totalDocumentos: coincidentes.length,
      documentosTruncados: documentos.length < coincidentes.length,
      origenDeMontos: 'suma_de_documentos',
      totales,
      // Con filtro por contraparte el declarado NO se expone: el SII lo calcula
      // sobre el período completo, así que junto a un subconjunto filtrado se
      // leería como el total de ese subconjunto. Un número que no significa lo
      // que parece es peor que ninguno.
      totalesDeclarados: contraparteBuscada ? null : declarados,
      totalesDifierenDelDeclarado:
        !contraparteBuscada &&
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
      montoNetoDeclarado: Number(f.mntNeto ?? 0),
      montoExentoDeclarado: Number(f.mntExento ?? 0),
      montoIvaDeclarado: Number(f.mntIVA ?? 0),
      montoTotalDeclarado: Number(f.mntTotal ?? 0),
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
