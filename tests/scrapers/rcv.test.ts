import * as fs from 'fs';
import * as path from 'path';
import { RcvScraper } from '../../src/scrapers/rcv';
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

function makeScraper(respuesta: any) {
  const http = new MockHttp({} as any);
  const session = new MockSession({} as any, {} as any);
  (http.postSdi as jest.Mock).mockResolvedValue(respuesta);
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { http, session, scraper: new RcvScraper(http, session) };
}

describe('RcvScraper.resumen', () => {
  it('consulta getResumen con el sobre del RCV', async () => {
    const { http, scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    await scraper.resumen('202607', 'VENTA', '22222222-2');

    const [base, namespace, metodo, data] = (http.postSdi as jest.Mock).mock.calls[0];
    expect(base).toContain('consdcvinternetui');
    expect(namespace).toBe('cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService');
    expect(metodo).toBe('getResumen');
    expect(data).toEqual({
      rutEmisor: '22222222',
      dvEmisor: '2',
      ptributario: '202607',
      estadoContab: 'REGISTRO',
      operacion: 'VENTA',
    });
  });

  it('parsea las filas por tipo de documento', async () => {
    const { scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    const resumen = await scraper.resumen('202607', 'VENTA', '22222222-2');

    expect(resumen.sinDatos).toBe(false);
    expect(resumen.totalDocumentos).toBe(415);
    expect(resumen.actualizadoAl).toBe('01/07/2026 08:17:45');
    expect(resumen.filas).toHaveLength(4);
    expect(resumen.filas[0]).toEqual({
      tipoDocCodigo: 33,
      tipoDocNombre: 'Factura Electrónica',
      documentos: 393,
      montoNeto: 100000000,
      montoExento: 0,
      montoIva: 19000000,
      montoTotal: 119000000,
      esNotaCredito: false,
      tipoDesconocido: false,
    });
  });

  // Las notas de crédito llegan con montos positivos, igual que una factura.
  // Sumarlas infla ventas e IVA y produce cifras que parecen plausibles.
  it('resta las notas de crédito al totalizar', async () => {
    const { scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    const resumen = await scraper.resumen('202607', 'VENTA', '22222222-2');

    const nc = resumen.filas.find(f => f.tipoDocCodigo === 61)!;
    expect(nc.esNotaCredito).toBe(true);
    expect(resumen.totales).toEqual({
      // 100.000.000 de facturas − 10.000.000 de notas de crédito.
      neto: 90000000,
      exento: 2000000,
      // 19.000.000 − 1.900.000.
      iva: 17100000,
      total: 108600000,
    });
    // La suma ingenua (sin restar) daría estos otros valores.
    expect(resumen.totales.neto).not.toBe(110000000);
    expect(resumen.totales.iva).not.toBe(20900000);
  });

  // Compras se verificó contra una respuesta real del portal, no se asumió: usa
  // exactamente los mismos nombres de campo que ventas (no hay sorpresa como la
  // que hubo entre boletas emitidas y recibidas).
  it('parsea el resumen de compras con el mismo esquema que ventas', async () => {
    const { http, scraper } = makeScraper(fixture('rcv-resumen-compra.json'));

    const resumen = await scraper.resumen('202607', 'COMPRA', '22222222-2');

    expect((http.postSdi as jest.Mock).mock.calls[0][3]).toMatchObject({
      operacion: 'COMPRA',
    });
    expect(resumen.sinDatos).toBe(false);
    expect(resumen.totalDocumentos).toBe(145);
    expect(resumen.actualizadoAl).toBe('29/07/2026 04:31:03');
    expect(resumen.filas).toHaveLength(5);
    expect(resumen.filas[2]).toEqual({
      tipoDocCodigo: 46,
      tipoDocNombre: 'Factura de Compra Electrónica',
      documentos: 35,
      montoNeto: 2000000,
      montoExento: 0,
      montoIva: 380000,
      montoTotal: 2380000,
      esNotaCredito: false,
      tipoDesconocido: false,
    });
  });

  // Las notas de crédito restan también en compras (acá rebajan el crédito
  // fiscal): la regla no es de ventas, es del registro.
  it('resta las notas de crédito también en compras', async () => {
    const { scraper } = makeScraper(fixture('rcv-resumen-compra.json'));

    const resumen = await scraper.resumen('202607', 'COMPRA', '22222222-2');

    expect(resumen.totales).toEqual({
      // 50.000.000 + 5.000.000 + 2.000.000 − 1.000.000 de notas de crédito.
      neto: 56000000,
      exento: 100000,
      iva: 10830000,
      total: 66930000,
    });
    // La suma ingenua (sin restar la nota de crédito) daría estos otros.
    expect(resumen.totales.neto).not.toBe(58000000);
    expect(resumen.totales.total).not.toBe(68930000);
  });

  // La nota de crédito de exportación (112) acompaña a la factura de
  // exportación (110), que la cuenta verificada sí emite. Sumarla infla las
  // ventas exactamente igual que sumar una 61.
  it('resta también la nota de crédito de exportación (112)', async () => {
    const { scraper } = makeScraper({
      respEstado: { codRespuesta: 0, msgeRespuesta: null },
      totDocRes: 2,
      data: [
        { rsmnTipoDocInteger: 110, dcvNombreTipoDoc: 'Factura de Exportación Electrónica',
          rsmnTotDoc: 1, rsmnMntNeto: 0, rsmnMntExe: 1000000, rsmnMntIVA: 0, rsmnMntTotal: 1000000 },
        { rsmnTipoDocInteger: 112, dcvNombreTipoDoc: 'Nota de Crédito de Exportación Electrónica',
          rsmnTotDoc: 1, rsmnMntNeto: 0, rsmnMntExe: 400000, rsmnMntIVA: 0, rsmnMntTotal: 400000 },
      ],
    });

    const resumen = await scraper.resumen('202607', 'VENTA', '22222222-2');

    expect(resumen.filas[1].esNotaCredito).toBe(true);
    expect(resumen.totales.exento).toBe(600000);
    expect(resumen.totales.total).toBe(600000);
    expect(resumen.totalesConfiables).toBe(true);
  });

  // El catálogo de tipos del SII es largo y no lo conocemos entero. Un tipo que
  // no está en ninguna lista se suma —es lo más frecuente— pero el resumen tiene
  // que decirlo: un total silenciosamente mal es peor que un error.
  it('marca los totales como no confiables ante un tipo de documento desconocido', async () => {
    const { scraper } = makeScraper({
      respEstado: { codRespuesta: 0, msgeRespuesta: null },
      totDocRes: 1,
      data: [
        { rsmnTipoDocInteger: 777, dcvNombreTipoDoc: 'Documento Nuevo del SII',
          rsmnTotDoc: 1, rsmnMntNeto: 500000, rsmnMntExe: 0, rsmnMntIVA: 95000, rsmnMntTotal: 595000 },
      ],
    });

    const resumen = await scraper.resumen('202607', 'VENTA', '22222222-2');

    expect(resumen.filas[0].tipoDesconocido).toBe(true);
    expect(resumen.totalesConfiables).toBe(false);
    expect(resumen.tiposDesconocidos).toEqual([
      { codigo: 777, nombre: 'Documento Nuevo del SII' },
    ]);
    // La advertencia nombra el código: resolverlo es mirar esta salida y
    // agregarlo a la lista que corresponda, no salir a reproducir el caso.
    expect(resumen.advertencias[0]).toMatch(/777/);
    // Los totales se calculan igual, sumando: no se rompe la consulta.
    expect(resumen.totales.neto).toBe(500000);
  });

  it('no marca nada cuando todos los tipos son conocidos', async () => {
    const { scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    const resumen = await scraper.resumen('202607', 'VENTA', '22222222-2');

    expect(resumen.totalesConfiables).toBe(true);
    expect(resumen.tiposDesconocidos).toEqual([]);
    expect(resumen.advertencias).toEqual([]);
  });

  // Éxito sin datos es una contradicción del servicio: un período vacío se
  // informa con el 3 o el 99, no con el 0. Devolverlo como resumen dejaba un
  // `totalDocumentos` que contradecía las cero filas.
  it('falla si el SII responde éxito pero sin datos', async () => {
    const { scraper } = makeScraper({
      data: null,
      totDocRes: 12,
      respEstado: { codRespuesta: 0, msgeRespuesta: null },
    });

    await expect(scraper.resumen('202607', 'VENTA', '22222222-2'))
      .rejects.toThrow(/contradictoria/);
  });

  // Código 3: el período no tiene documentos registrados. Un mes tranquilo no
  // es una falla.
  it('trata el código 3 como período sin movimientos', async () => {
    const { scraper } = makeScraper({
      data: null,
      respEstado: { codRespuesta: 3, msgeRespuesta: null },
    });

    const resumen = await scraper.resumen('202607', 'COMPRA', '22222222-2');

    expect(resumen.sinDatos).toBe(true);
    expect(resumen.filas).toEqual([]);
    expect(resumen.totalDocumentos).toBe(0);
    expect(resumen.totales).toEqual({ neto: 0, exento: 0, iva: 0, total: 0 });
  });

  // Código 2: error real. Tratarlo como vacío lo escondería detrás de un
  // resumen en cero que se ve perfectamente normal.
  it('distingue el error (código 2) del vacío legítimo (código 3)', async () => {
    const { scraper } = makeScraper({
      data: null,
      respEstado: { codRespuesta: 2, msgeRespuesta: 'Error interno' },
    });

    await expect(scraper.resumen('202607', 'VENTA', '22222222-2'))
      .rejects.toThrow(/Error interno/);
  });

  it('falla explícito ante el código 98 (redirección)', async () => {
    const { scraper } = makeScraper({
      data: null,
      respEstado: { codRespuesta: 98, msgeRespuesta: null },
    });

    await expect(scraper.resumen('202607', 'VENTA', '22222222-2'))
      .rejects.toThrow(/98/);
  });

  // Código 99: el período es anterior al que el registro cubre. Es otro vacío
  // legítimo, con el mensaje del SII explicando por qué vino vacío.
  it('trata el código 99 como período fuera del rango disponible', async () => {
    const { scraper } = makeScraper(fixture('rcv-resumen-vacio.json'));

    const resumen = await scraper.resumen('201501', 'VENTA', '22222222-2');

    expect(resumen.sinDatos).toBe(true);
    expect(resumen.filas).toEqual([]);
    expect(resumen.totales).toEqual({ neto: 0, exento: 0, iva: 0, total: 0 });
    // El vacío se puede explicar: no es lo mismo que un mes reciente sin
    // actividad, que llega sin mensaje.
    expect(resumen.mensaje).toMatch(/mayor igual a 201705/);
  });

  // Default seguro: la lista de códigos del SII ya demostró no ser exhaustiva
  // (así apareció el 99). Un código nuevo no puede caer en la rama de vacío.
  it('no reporta como vacío un código desconocido', async () => {
    const { scraper } = makeScraper({
      data: null,
      respEstado: { codRespuesta: 77, msgeRespuesta: 'Algo nuevo del SII' },
    });

    const consulta = scraper.resumen('202607', 'VENTA', '22222222-2');

    // El código y el mensaje van en el error: es lo que hace falta para
    // diagnosticar al próximo desconocido sin salir a reproducirlo.
    await expect(consulta).rejects.toThrow(/desconocido/);
    await expect(scraper.resumen('202607', 'VENTA', '22222222-2'))
      .rejects.toThrow(/77.*Algo nuevo del SII/);
  });

  it('reporta el sobre mal armado citando el mensaje del SII', async () => {
    const { scraper } = makeScraper({ errorMsg: 'Acceso no autorizado!' });

    await expect(scraper.resumen('202607', 'VENTA', '22222222-2'))
      .rejects.toThrow(/Acceso no autorizado/);
  });

  // La empresa es un parámetro del método, no un estado de la sesión: se puede
  // consultar otra empresa sin seleccionarla en ninguna pantalla.
  it('acepta una empresa distinta en cada llamada', async () => {
    const { http, scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    await scraper.resumen('202607', 'VENTA', '22222222-2');
    await scraper.resumen('202607', 'VENTA', '33333333-3');

    expect((http.postSdi as jest.Mock).mock.calls[1][3]).toMatchObject({
      rutEmisor: '33333333', dvEmisor: '3',
    });
  });

  it('usa el RUT autenticado si no se pasa empresa_rut', async () => {
    const { http, scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    const resumen = await scraper.resumen('202607', 'COMPRA');

    expect((http.postSdi as jest.Mock).mock.calls[0][3]).toMatchObject({
      rutEmisor: '11111111', dvEmisor: '1',
    });
    expect(resumen.empresaRut).toBe('11111111-1');
  });

  it('rechaza un período que no es AAAAMM', async () => {
    const { http, scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    await expect(scraper.resumen('2026-07', 'VENTA')).rejects.toThrow(/AAAAMM/);
    await expect(scraper.resumen('202613', 'VENTA')).rejects.toThrow(/AAAAMM/);
    expect(http.postSdi).not.toHaveBeenCalled();
  });

  it('rechaza un RUT de empresa mal formado', async () => {
    const { scraper } = makeScraper(fixture('rcv-resumen-venta.json'));

    await expect(scraper.resumen('202607', 'VENTA', 'no-es-un-rut'))
      .rejects.toThrow(/RUT de empresa inválido/);
  });

  it('falla antes de consultar si la sesión no puede entregar el cookie jar', async () => {
    const { http, scraper, session } = makeScraper(fixture('rcv-resumen-venta.json'));
    (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {
      throw new Error('requiere certificado');
    });

    await expect(scraper.resumen('202607', 'VENTA')).rejects.toThrow(/certificado/);
    expect(http.postSdi).not.toHaveBeenCalled();
  });
});
