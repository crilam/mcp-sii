import * as fs from 'fs';
import * as path from 'path';
import { DteScraper } from '../../src/scrapers/dte';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '../fixtures', nombre), 'utf-8')
  );
}

// El scraper hace una llamada de resumen y después una de detalle por fila, así
// que el doble responde según el método que se le pidió.
function makeScraper(porMetodo: Record<string, any>) {
  const http = new MockHttp({} as any);
  const session = new MockSession({} as any, {} as any);
  (http.postSdi as jest.Mock).mockImplementation(
    async (_base: string, _ns: string, metodo: string) => {
      if (!(metodo in porMetodo)) {
        throw new Error(`El test no preparó respuesta para ${metodo}`);
      }
      return porMetodo[metodo];
    }
  );
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { http, session, scraper: new DteScraper(http, session) };
}

function llamadas(http: SiiHttpClient) {
  return (http.postSdi as jest.Mock).mock.calls;
}

function llamada(http: SiiHttpClient, metodo: string) {
  return llamadas(http).find(c => c[2] === metodo);
}

const EMITIDOS = {
  getResumen: fixture('dte-resumen-op1.json'),
  getDetalle: fixture('dte-detalle-emitidos.json'),
};

const RECIBIDOS = {
  getResumen: fixture('dte-resumen-op2.json'),
  getDetalleRecibidos: fixture('dte-detalle-recibidos.json'),
};

describe('DteScraper: el sobre de la consulta', () => {
  it('getResumen usa el período con guión y rutContribuyente/dvContribuyente', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await scraper.listar('202607', 'EMITIDOS', {
      empresaRut: '22222222-2',
      incluirDetalle: false,
    });

    const [base, namespace, metodo, data] = llamada(http, 'getResumen')!;
    expect(base).toContain('consemitidosinternetui');
    expect(namespace).toBe('cl.sii.sdi.lob.diii.consemitidos.data.api.interfaces.FacadeService');
    expect(metodo).toBe('getResumen');
    // AAAA-MM CON GUIÓN: sin él la consulta no devuelve nada.
    expect(data).toEqual({
      periodo: '2026-07',
      rutContribuyente: '22222222',
      dvContribuyente: '2',
      operacion: 1,
    });
  });

  it('getResumen manda operacion 2 en recibidos', async () => {
    const { http, scraper } = makeScraper(RECIBIDOS);

    await scraper.listar('202607', 'RECIBIDOS', { incluirDetalle: false });

    expect(llamada(http, 'getResumen')![3].operacion).toBe(2);
  });

  // Los dos métodos del MISMO servicio usan nombres distintos para lo mismo:
  // getResumen quiere rutContribuyente/dvContribuyente y getDetalle quiere
  // rut/dv. Mandar el equivocado da un 400 que nombra la clase Java.
  it('getDetalle usa rut/dv, NO rutContribuyente/dvContribuyente', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await scraper.listar('202607', 'EMITIDOS', {
      empresaRut: '22222222-2',
      tipoDocCodigo: 33,
      incluirDetalle: true,
    });

    const data = llamada(http, 'getDetalle')![3];
    expect(data).toEqual({
      tipoDoc: 33,
      rut: '22222222',
      dv: '2',
      periodo: '2026-07',
      operacion: 1,
      // derrCodigo va con el mismo valor que tipoDoc.
      derrCodigo: 33,
      // refNCD sale de la fila del resumen.
      refNCD: 0,
    });
    expect(Object.keys(data)).not.toContain('rutContribuyente');
    expect(Object.keys(data)).not.toContain('dvContribuyente');
  });

  it('recibidos usa getDetalleRecibidos con los mismos nombres rut/dv', async () => {
    const { http, scraper } = makeScraper(RECIBIDOS);

    await scraper.listar('202607', 'RECIBIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(llamada(http, 'getDetalle')).toBeUndefined();
    const data = llamada(http, 'getDetalleRecibidos')![3];
    expect(data.rut).toBe('11111111');
    expect(data.dv).toBe('1');
    expect(data.operacion).toBe(2);
  });

  it('rechaza un período mal escrito antes de consultar', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await expect(scraper.listar('2026-07', 'EMITIDOS')).rejects.toThrow(/AAAAMM/);
    expect(llamadas(http)).toHaveLength(0);
  });
});

describe('DteScraper.listar: el resumen', () => {
  // Agrupar por tipoDoc solo colapsa las dos filas del 61 y suma mal.
  it('la clave de una fila es (tipoDoc, seccion), no tipoDoc', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { incluirDetalle: false });

    expect(r.filas).toHaveLength(7);
    const nc = r.filas.filter(f => f.tipoDocCodigo === 61);
    expect(nc).toHaveLength(2);
    expect(nc.map(f => f.seccion)).toEqual(['S1', 'S2']);
    // Las dos filas del 61 son distintas: distinta cantidad y distinto refNCD,
    // que es justamente lo que hay que devolverle al SII para pedir cada una.
    expect(nc.map(f => f.documentos)).toEqual([20, 2]);
    expect(nc.map(f => f.refNCD)).toEqual([0, 1]);

    // Cada (tipo, sección) aparece una sola vez: nada se colapsó.
    const claves = r.filas.map(f => `${f.tipoDocCodigo}/${f.seccion}`);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it('parsea una fila del resumen completa', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { incluirDetalle: false });

    expect(r.filas[0]).toEqual({
      tipoDocCodigo: 33,
      tipoDocNombre: 'Factura Electronica',
      seccion: 'S1',
      seccionDescripcion: 'Documentos afectos y exentos',
      documentos: 393,
      montoNeto: 1000000,
      montoExento: 0,
      montoIva: 190000,
      montoTotal: 1190000,
      refNCD: 0,
      documentosNotaCreditoDebito: 0,
    });
    expect(r.empresaRut).toBe('11111111-1');
    expect(r.sinDatos).toBe(false);
  });

  it('nombra las secciones relevadas y deja null la desconocida', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { incluirDetalle: false });

    const porSeccion = new Map(r.filas.map(f => [f.seccion, f.seccionDescripcion]));
    expect(porSeccion.get('S2')).toContain('Facturas de compra');
    expect(porSeccion.get('S4')).toBe('Exportación');
    expect(porSeccion.get('S5')).toBe('Guías de despacho');
  });

  it('sin detalle hace UNA sola consulta', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await scraper.listar('202607', 'EMITIDOS', { incluirDetalle: false });

    expect(llamadas(http)).toHaveLength(1);
  });

  // El detalle es OPT-IN: por defecto una sola consulta. Sin esto, un listado
  // sin `tipoDocCodigo` dispara una consulta por fila del resumen (siete acá) y
  // el límite de sesiones del SII se agota sin que nadie lo haya pedido.
  it('el detalle NO se trae por defecto', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS');

    expect(llamadas(http)).toHaveLength(1);
    expect(r.documentos).toEqual([]);
    // El resumen sí trae la cuenta de documentos del período.
    expect(r.filas).toHaveLength(7);
    expect(r.totalDocumentos).toBe(474);
  });

  it('con detalle pide una consulta por fila del resumen filtrada', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    // El tipo 61 tiene dos filas (S1 y S2): son dos consultas de detalle.
    await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 61, incluirDetalle: true });

    const detalles = llamadas(http).filter(c => c[2] === 'getDetalle');
    expect(detalles).toHaveLength(2);
    expect(detalles.map(c => c[3].refNCD)).toEqual([0, 1]);
  });

  it('el filtro por sección acota a una sola fila', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 61,
      seccion: 'S2',
      incluirDetalle: true,
    });

    expect(r.filas).toHaveLength(1);
    expect(r.filas[0].seccion).toBe('S2');
    expect(llamadas(http).filter(c => c[2] === 'getDetalle')).toHaveLength(1);
  });
});

describe('DteScraper.listar: el detalle', () => {
  it('lee los documentos de dataResp.detalles, no de data', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    // `data` viene null en la respuesta del detalle: un parser que la mire ve
    // un período vacío donde hay documentos.
    expect(EMITIDOS.getDetalle.data).toBeNull();

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.totalDocumentos).toBe(4);
    expect(r.documentos.map(d => d.folio)).toEqual([1000, 1001, 1002, 1003]);
  });

  it('parsea un documento emitido completo', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.documentos[0]).toEqual({
      tipoDocCodigo: 33,
      seccion: 'S1',
      contraparteRut: '22222222-2',
      contraparteNombre: 'CLIENTE EJEMPLO UNO SPA',
      contraparteRol: 'receptor',
      folio: 1000,
      fechaEmision: '01/07/2026',
      fechaRecepcion: '01/07/2026',
      montoNeto: 1000000,
      montoExento: 0,
      montoIva: 190000,
      montoTotal: 1190000,
      tasaIva: 19,
      eventoCodigo: '5',
      // dehDescripcion viene "" cuando no hubo evento: se normaliza a null.
      eventoDescripcion: null,
      documentoCodigo: 900000000,
    });
  });

  it('conserva la descripción del evento cuando el SII la informa', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    const conEvento = r.documentos.find(d => d.folio === 1003)!;
    expect(conEvento.eventoCodigo).toBe('2');
    expect(conEvento.eventoDescripcion).toBe('Acuse Recibo');
  });
});

// LA TRAMPA: la contraparte viene siempre en los campos `*Receptor`, en las dos
// operaciones. En recibidos eso es el EMISOR — el proveedor.
describe('DteScraper: el rol de la contraparte', () => {
  it('en emitidos la contraparte es el receptor (el cliente)', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.documentos.every(d => d.contraparteRol === 'receptor')).toBe(true);
  });

  it('en recibidos la contraparte es el EMISOR, aunque venga en rznSocRecep', async () => {
    const { scraper } = makeScraper(RECIBIDOS);

    // Los campos *Emisor llegan SIEMPRE null: el proveedor está en rznSocRecep.
    const crudo = RECIBIDOS.getDetalleRecibidos.dataResp.detalles[0];
    expect(crudo.rutEmisor).toBeNull();
    expect(crudo.rznSocEmisor).toBeNull();
    expect(crudo.rznSocRecep).toContain('PROVEEDOR');

    const r = await scraper.listar('202607', 'RECIBIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.documentos.every(d => d.contraparteRol === 'emisor')).toBe(true);
    // El nombre sale de rznSocRecep y el RUT se compone de rutReceptor+dvReceptor,
    // que es el punto: los campos se llaman "receptor" y traen al proveedor. Se
    // comparan contra la fixture en vez de contra un literal, porque lo que
    // importa es DE DÓNDE se leen, no qué RUT concreto trae la fila.
    expect(r.documentos[0].contraparteNombre).toBe(crudo.rznSocRecep);
    expect(r.documentos[0].contraparteRut).toBe(`${crudo.rutReceptor}-${crudo.dvReceptor}`);
  });
});

// `documentos: []` se veía idéntico en dos situaciones que no son la misma:
// "no se pidió el detalle" y "no hay documentos". `detalleIncluido` las separa,
// y estos dos tests las fijan por separado porque desde afuera se confunden.
describe('DteScraper.listar: detalle no pedido contra detalle vacío', () => {
  it('sin pedir el detalle: documentos vacío con detalleIncluido=false', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33 });

    expect(r.detalleIncluido).toBe(false);
    expect(r.documentos).toEqual([]);
    // Y los documentos EXISTEN: el resumen dice que hay 393. La lista está
    // vacía porque no se pidió, no porque no haya nada.
    expect(r.totalDocumentos).toBe(393);
    expect(r.sinDatos).toBe(false);
  });

  it('pidiendo el detalle y sin documentos: detalleIncluido=true y lista vacía', async () => {
    const { scraper } = makeScraper({
      getResumen: EMITIDOS.getResumen,
      getDetalle: {
        data: null,
        dataResp: { detalles: [], totMntNeto: 0, totMntExe: 0, totMntIVA: 0, totMntTotal: 0 },
        respEstado: { codRespuesta: 0, msgeRespuesta: null, codError: null },
      },
    });

    const r = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 33,
      incluirDetalle: true,
    });

    expect(r.detalleIncluido).toBe(true);
    expect(r.documentos).toEqual([]);
    expect(r.totalDocumentos).toBe(0);
    expect(r.sinDatos).toBe(true);
  });

  it('un período sin filas informa detalleIncluido=false aunque se pida el detalle', async () => {
    const { scraper } = makeScraper({
      getResumen: {
        data: { resumenDte: [], datosAsync: null },
        respEstado: { codRespuesta: 0, msgeRespuesta: null, codError: null },
      },
    });

    // Sin filas no hay ningún detalle que pedirle al SII: decir que se incluyó
    // sería afirmar algo que no pasó.
    const r = await scraper.listar('202607', 'EMITIDOS', { incluirDetalle: true });

    expect(r.detalleIncluido).toBe(false);
    expect(r.sinDatos).toBe(true);
  });
});

// `limit` y `contraparteRut` son filtros del lado del cliente: el servicio del
// SII no los recibe. No ahorran llamadas, y los tests lo fijan para que nadie
// los lea como si acotaran la consulta.
describe('DteScraper.listar: los filtros del lado del cliente', () => {
  it('el filtro por contraparte no cambia las consultas al SII', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    const conFiltro = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 33,
      incluirDetalle: true,
      contraparteRut: '33333333-3',
    });

    // Una de resumen y una de detalle: las mismas que sin filtro.
    expect(llamadas(http)).toHaveLength(2);
    expect(llamadas(http)[1][3]).not.toHaveProperty('contraparteRut');

    expect(conFiltro.documentos).toHaveLength(1);
    expect(conFiltro.documentos[0].contraparteRut).toBe('33333333-3');
    expect(conFiltro.totalDocumentos).toBe(1);
    // Los totales son los del subconjunto filtrado, no los del período.
    expect(conFiltro.totales.total).toBe(1190000);
  });

  it('acepta el RUT de contraparte con puntos o sin guión', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    for (const forma of ['33.333.333-3', '333333333', '33333333-3']) {
      const r = await scraper.listar('202607', 'EMITIDOS', {
        tipoDocCodigo: 33,
        incluirDetalle: true,
        contraparteRut: forma,
      });
      expect(r.documentos).toHaveLength(1);
    }
  });

  // Un vacío por filtro sigue siendo un vacío legítimo, no un error.
  it('una contraparte sin documentos da sinDatos, no falla', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 33,
      incluirDetalle: true,
      contraparteRut: '55555555-5',
    });

    expect(r.documentos).toEqual([]);
    expect(r.totalDocumentos).toBe(0);
    expect(r.sinDatos).toBe(true);
  });

  // Con un subconjunto filtrado el total declarado por el SII —que es del
  // período completo— se leería como el total de ese subconjunto.
  it('con filtro por contraparte no expone el total declarado', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 33,
      incluirDetalle: true,
      contraparteRut: '33333333-3',
    });

    expect(r.totalesDeclarados).toBeNull();
    expect(r.totalesDifierenDelDeclarado).toBe(false);
  });

  it('un RUT de contraparte mal escrito falla en vez de devolver vacío', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    // Devolver cero documentos se leería como "esa contraparte no tiene
    // documentos", que es peor que un error.
    await expect(
      scraper.listar('202607', 'EMITIDOS', {
        tipoDocCodigo: 33,
        incluirDetalle: true,
        contraparteRut: 'no-es-un-rut',
      })
    ).rejects.toThrow(/RUT de contraparte/);
  });

  it('limit recorta la lista, avisa que recortó y no toca los totales', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 33,
      incluirDetalle: true,
      limit: 2,
    });

    expect(r.documentos).toHaveLength(2);
    expect(r.documentosTruncados).toBe(true);
    // El total de documentos es el real, no el de la página.
    expect(r.totalDocumentos).toBe(4);
    // Y los totales cubren los 4: si dependieran del tamaño de página, cambiar
    // `limit` cambiaría los montos del período.
    expect(r.totales.total).toBe(4760000);
    // No ahorra llamadas: recorta después de traer.
    expect(llamadas(http)).toHaveLength(2);
  });

  it('un limit que no recorta deja documentosTruncados en false', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', {
      tipoDocCodigo: 33,
      incluirDetalle: true,
      limit: 50,
    });

    expect(r.documentos).toHaveLength(4);
    expect(r.documentosTruncados).toBe(false);
  });
});

// El total declarado por el SII NO es la suma de las filas. La fixture preserva
// ese desajuste a propósito: 4.000.000 sumando contra 9.999.999 declarados.
describe('DteScraper: la totalización', () => {
  it('suma los documentos y NO usa el total declarado', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.totales).toEqual({
      neto: 4000000,
      exento: 0,
      iva: 760000,
      total: 4760000,
    });
    // Si algún día esto vale 9999999, alguien "arregló" la totalización usando
    // el campo que parece más directo. No lo es: no es el mismo número.
    expect(r.totales.neto).not.toBe(9999999);
  });

  it('expone el total declarado aparte y avisa que difiere', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.totalesDeclarados).toEqual({
      neto: 9999999,
      exento: 0,
      iva: 1899999,
      total: 11899998,
    });
    expect(r.totalesDifierenDelDeclarado).toBe(true);
  });

  it('en recibidos la totalización también suma los documentos', async () => {
    const { scraper } = makeScraper(RECIBIDOS);

    const r = await scraper.listar('202607', 'RECIBIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.totales.total).toBe(4760000);
    expect(r.totalesDeclarados!.total).toBe(11899998);
  });
});

describe('DteScraper.getDocumento', () => {
  it('encuentra el documento por tipo y folio', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const d = await scraper.getDocumento('202607', 'EMITIDOS', 33, 1002);

    expect(d.encontrado).toBe(true);
    expect(d.documento!.folio).toBe(1002);
    expect(d.documento!.contraparteRol).toBe('receptor');
  });

  // Un folio de otro período no es un error: el SII entrega por período.
  it('un folio que no está en el período responde encontrado=false', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    const d = await scraper.getDocumento('202607', 'EMITIDOS', 33, 999999);

    expect(d.encontrado).toBe(false);
    expect(d.documento).toBeNull();
  });

  // El tipo 61 está en dos secciones: no alcanza con mirar la primera.
  it('recorre todas las secciones del tipo', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await scraper.getDocumento('202607', 'EMITIDOS', 61, 999999);

    expect(llamadas(http).filter(c => c[2] === 'getDetalle')).toHaveLength(2);
  });

  it('rechaza un folio o un tipo inválidos', async () => {
    const { scraper } = makeScraper(EMITIDOS);

    await expect(scraper.getDocumento('202607', 'EMITIDOS', 0, 1)).rejects.toThrow(/tipo de documento/);
    await expect(scraper.getDocumento('202607', 'EMITIDOS', 33, 0)).rejects.toThrow(/Folio/);
  });
});

describe('DteScraper: vacío legítimo contra error real', () => {
  const vacio = {
    data: { resumenDte: [], datosAsync: null },
    respEstado: { codRespuesta: 0, msgeRespuesta: null, codError: null },
  };

  it('un período sin documentos es sinDatos, no un error', async () => {
    const { scraper } = makeScraper({ getResumen: vacio });

    const r = await scraper.listar('202607', 'EMITIDOS');

    expect(r.sinDatos).toBe(true);
    expect(r.filas).toEqual([]);
    expect(r.documentos).toEqual([]);
    expect(r.totales).toEqual({ neto: 0, exento: 0, iva: 0, total: 0 });
    expect(r.totalesDeclarados).toBeNull();
  });

  it('resumenDte null también es vacío legítimo', async () => {
    const { scraper } = makeScraper({
      getResumen: {
        data: null,
        respEstado: { codRespuesta: 0, msgeRespuesta: null, codError: null },
      },
    });

    await expect(scraper.listar('202607', 'EMITIDOS')).resolves.toMatchObject({
      sinDatos: true,
    });
  });

  it('un detalle vacío no rompe el listado', async () => {
    const { scraper } = makeScraper({
      getResumen: EMITIDOS.getResumen,
      getDetalle: {
        data: null,
        dataResp: { detalles: [], totMntNeto: 0, totMntExe: 0, totMntIVA: 0, totMntTotal: 0 },
        respEstado: { codRespuesta: 0, msgeRespuesta: null, codError: null },
      },
    });

    const r = await scraper.listar('202607', 'EMITIDOS', { tipoDocCodigo: 33, incluirDetalle: true });

    expect(r.documentos).toEqual([]);
    expect(r.filas).toHaveLength(1);
  });

  // 99 acá es "Usuario no autorizado" — un ERROR. En el RCV el mismo 99 es un
  // período fuera de rango, que sí es vacío legítimo. No se comparte la tabla.
  it('el código 99 es usuario no autorizado y FALLA', async () => {
    const { scraper } = makeScraper({
      getResumen: {
        data: null,
        respEstado: {
          codRespuesta: 99,
          msgeRespuesta: 'Usuario no autorizado',
          codError: 'cnsmtds.1.1.00',
        },
      },
    });

    await expect(scraper.listar('202607', 'EMITIDOS')).rejects.toThrow(
      /usuario no autorizado/i
    );
    await expect(scraper.listar('202607', 'EMITIDOS')).rejects.toThrow(/cnsmtds\.1\.1\.00/);
  });

  it('un código desconocido FALLA citando el código y el mensaje', async () => {
    const { scraper } = makeScraper({
      getResumen: {
        data: null,
        respEstado: { codRespuesta: 77, msgeRespuesta: 'algo nuevo', codError: null },
      },
    });

    const p = scraper.listar('202607', 'EMITIDOS');
    await expect(p).rejects.toThrow(/77/);
    await expect(scraper.listar('202607', 'EMITIDOS')).rejects.toThrow(/algo nuevo/);
  });

  it('el sobre mal armado explica que no es un problema de permisos', async () => {
    const { scraper } = makeScraper({
      getResumen: { errorMsg: 'Acceso no autorizado!' },
    });

    await expect(scraper.listar('202607', 'EMITIDOS')).rejects.toThrow(/sobre de la petición/);
  });
});

describe('DteScraper: la empresa es parámetro, no estado de sesión', () => {
  it('sin empresaRut consulta el RUT autenticado', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    const r = await scraper.listar('202607', 'EMITIDOS', { incluirDetalle: false });

    expect(llamada(http, 'getResumen')![3].rutContribuyente).toBe('11111111');
    expect(r.empresaRut).toBe('11111111-1');
  });

  it('dos empresas distintas en dos llamadas seguidas, sin paso previo', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await scraper.listar('202607', 'EMITIDOS', {
      empresaRut: '22222222-2',
      incluirDetalle: false,
    });
    await scraper.listar('202607', 'EMITIDOS', {
      empresaRut: '33333333-3',
      incluirDetalle: false,
    });

    const ruts = llamadas(http).map(c => c[3].rutContribuyente);
    expect(ruts).toEqual(['22222222', '33333333']);
  });

  it('un RUT de empresa mal escrito falla antes de consultar', async () => {
    const { http, scraper } = makeScraper(EMITIDOS);

    await expect(
      scraper.listar('202607', 'EMITIDOS', { empresaRut: 'no-es-un-rut' })
    ).rejects.toThrow(/RUT de empresa/);
    expect(llamadas(http)).toHaveLength(0);
  });

  it('exige poder entregar el cookie jar antes de consultar', async () => {
    const { session, scraper } = makeScraper(EMITIDOS);
    (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {
      throw new Error('sesión excluida');
    });

    await expect(scraper.listar('202607', 'EMITIDOS')).rejects.toThrow('sesión excluida');
  });
});
