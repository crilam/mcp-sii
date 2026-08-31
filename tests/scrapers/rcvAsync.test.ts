import * as zlib from 'zlib';
import { RcvAsyncScraper } from '../../src/scrapers/rcvAsync';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { RecursoNoEncontrado, LimitacionConocida } from '../../src/erroresConsulta';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// Una fila del control async (ca*), con lo mínimo que el scraper lee.
function ctrl(over: Record<string, unknown> = {}) {
  return {
    caProceso: 'CONSDCV_C_RG', caRutEmisor: 11111111, caDvEmisor: '1',
    caPeriodo: 202601, caTipoDoc: 33, caId: 500, caIdBLOB: 'SIN-BLOB',
    caEstado: 'CREADO', caTmstCreado: '31/08/2026 01:00:00', caTmstEnProceso: null,
    caTmstTerminado: null, caFileSize: 0, caNumLineas: 0, caDescError: null, ...over,
  };
}

function armar() {
  const http = new MockHttp({} as any);
  const session = new MockSession({} as any, {} as any);
  (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn();
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { http, session, scraper: new RcvAsyncScraper(http, session) };
}

// CSV del SII: cabecera + filas separadas por `;` con separador final, más una
// fila de continuación (otro impuesto) con "Nro" vacío que NO es un documento.
const CSV = [
  'Nro;Tipo Compra;RUT Proveedor;Monto Total',
  '1;Del Giro;76756633-6;597110;',
  '2;Del Giro;77022092-0;280318;',
  ';Del Giro;77022092-0;0;',   // continuación del doc 2: Nro vacío
].join('\n');

describe('RcvAsyncScraper.solicitar', () => {
  it('crea con generaCtrl:true y reCAPTCHA vacío, y normaliza la fila', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({ respEstado: { codRespuesta: 0 }, data: [ctrl({ caId: 501 })] });

    const s = await scraper.solicitar('202601', 'COMPRA', 33);

    const [, , metodo, data] = (http.postSdi as jest.Mock).mock.calls[0];
    expect(metodo).toBe('getCtrlAsync');
    expect(data).toMatchObject({ rutEmisor: '11111111', ptributario: '202601', codTipoDoc: '33', generaCtrl: true, operacion: 'COMPRA', accionRecaptcha: '', tokenRecaptcha: '' });
    expect(s).toMatchObject({ solicitudId: 501, estado: 'CREADO', terminada: false, blobId: null, operacion: 'COMPRA' });
  });

  it('deriva VENTA del caProceso (_V_)', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({ respEstado: { codRespuesta: 0 }, data: [ctrl({ caProceso: 'CONSDCV_V_RG', caTipoDoc: 33 })] });
    const s = await scraper.solicitar('202601', 'VENTA', 33);
    expect(s.operacion).toBe('VENTA');
  });
});

describe('RcvAsyncScraper.estado', () => {
  it('filtra por período/tipo/operación y ordena nuevas primero', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({
      respEstado: { codRespuesta: 0 },
      data: [
        ctrl({ caId: 500, caEstado: 'EN PROCESO' }),
        ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1', caNumLineas: 2 }),
        ctrl({ caId: 900, caPeriodo: 202512 }),        // otro período: se descarta
        ctrl({ caId: 950, caTipoDoc: 61 }),            // otro tipo: se descarta
      ],
    });

    const lista = await scraper.estado('202601', 'COMPRA', 33);

    expect(lista.map(s => s.solicitudId)).toEqual([700, 500]);
    expect(lista[0]).toMatchObject({ estado: 'TERMINADO', terminada: true, blobId: 'uuid-1' });
  });

  // El patrón que más duele en este repo: un código inesperado NO es "sin
  // solicitudes", es un problema que no puede leerse como vacío.
  it('un código distinto de 0/1 falla, no devuelve vacío', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({ respEstado: { codRespuesta: 2, msgeRespuesta: 'Error X' } });
    await expect(scraper.estado('202601', 'COMPRA', 33)).rejects.toThrow(/código 2.*Error X/);
  });

  // El código 1 es una respuesta CON datos y un aviso: se acepta, no falla.
  it('el código 1 (con aviso) se acepta como respuesta con datos', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({
      respEstado: { codRespuesta: 1, msgeRespuesta: 'Aviso del SII' },
      data: [ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1' })],
    });
    const lista = await scraper.estado('202601', 'COMPRA', 33);
    expect(lista).toHaveLength(1);
  });

  // Con empresa_rut la consulta va por esa empresa (rutEmisor), no por el
  // RUT autenticado.
  it('empresa_rut viaja como rutEmisor/dvEmisor en el sobre', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({ respEstado: { codRespuesta: 0 }, data: [] });
    await scraper.estado('202601', 'COMPRA', 33, '22222222-2');
    const data = (http.postSdi as jest.Mock).mock.calls[0][3];
    expect(data).toMatchObject({ rutEmisor: '22222222', dvEmisor: '2' });
  });
});

describe('RcvAsyncScraper.detalle', () => {
  function conEstado(data: any[]) {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({ respEstado: { codRespuesta: 0 }, data });
    return { http, scraper };
  }
  const gz = (csv: string) => ({ contenido: zlib.gzipSync(Buffer.from(csv, 'latin1')), contentType: 'text/csv' });

  it('descarga, descomprime y parsea; cuenta documentos por "Nro" (no filas)', async () => {
    const { http, scraper } = conEstado([ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1', caNumLineas: 2 })]);
    (http.getBinario as jest.Mock).mockResolvedValue(gz(CSV));

    const det = await scraper.detalle('202601', 'COMPRA', 33);

    // 3 filas de datos (una es continuación), pero 2 documentos.
    expect(det.filas).toHaveLength(3);
    expect(det.totalDocumentos).toBe(2);
    expect(det.columnas).toEqual(['Nro', 'Tipo Compra', 'RUT Proveedor', 'Monto Total']);
    // La URL del BLOB usa el rut autenticado como `usuario` y como rutEmisor.
    const url = (http.getBinario as jest.Mock).mock.calls[0][0];
    expect(url).toContain('/obtenerArchivoBLOB/uuid-1/11111111/11111111/700');
  });

  it('sin solicitudes es NO_ENCONTRADO', async () => {
    const { scraper } = conEstado([]);
    await expect(scraper.detalle('202601', 'COMPRA', 33)).rejects.toBeInstanceOf(RecursoNoEncontrado);
  });

  it('con solicitud EN PROCESO es LimitacionConocida (reintentar), no un vacío', async () => {
    const { scraper } = conEstado([ctrl({ caId: 700, caEstado: 'EN PROCESO' })]);
    await expect(scraper.detalle('202601', 'COMPRA', 33)).rejects.toBeInstanceOf(LimitacionConocida);
  });

  // TERMINADO pero SIN blob es un fallo del SII: reintentar no lo arregla, así
  // que NO es LimitacionConocida (que invita a reintentar) sino un error duro.
  it('TERMINADO sin blob es un error duro, no invita a reintentar', async () => {
    const { scraper } = conEstado([ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'SIN-BLOB', caDescError: 'sin archivo' })]);
    const p = scraper.detalle('202601', 'COMPRA', 33);
    await expect(p).rejects.toThrow(/terminó sin archivo.*sin archivo/);
    await expect(p).rejects.not.toBeInstanceOf(LimitacionConocida);
  });

  // Con empresa_rut la URL del BLOB usa la empresa como rutEmisor y el RUT
  // autenticado como `usuario`.
  it('empresa_rut: la URL del BLOB separa usuario (autenticado) y rutEmisor (empresa)', async () => {
    const { http, scraper } = conEstado([ctrl({ caProceso: 'CONSDCV_C_RG', caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1', caNumLineas: 2 })]);
    (http.getBinario as jest.Mock).mockResolvedValue(gz(CSV));
    await scraper.detalle('202601', 'COMPRA', 33, '22222222-2');
    const url = (http.getBinario as jest.Mock).mock.calls[0][0];
    expect(url).toContain('/obtenerArchivoBLOB/uuid-1/11111111/22222222/700');
  });

  it('si los documentos no cuadran con los registros del SII, falla', async () => {
    const { http, scraper } = conEstado([ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1', caNumLineas: 5 })]);
    (http.getBinario as jest.Mock).mockResolvedValue(gz(CSV)); // trae 2 docs, no 5
    await expect(scraper.detalle('202601', 'COMPRA', 33)).rejects.toThrow(/2 documentos.*declaró 5/);
  });

  it('un archivo que no es gzip no es "sin documentos": falla', async () => {
    const { http, scraper } = conEstado([ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1', caNumLineas: 2 })]);
    (http.getBinario as jest.Mock).mockResolvedValue({ contenido: Buffer.from('<html>sesion</html>'), contentType: 'text/html' });
    await expect(scraper.detalle('202601', 'COMPRA', 33)).rejects.toThrow(/no devolvió un \.csv\.gz/);
  });

  it('una fila con columnas de más (que no sea el separador final) falla', async () => {
    const roto = 'Nro;Tipo Compra;Monto Total\n1;Del Giro;100;extra;';
    const { http, scraper } = conEstado([ctrl({ caId: 700, caEstado: 'TERMINADO', caIdBLOB: 'uuid-1', caNumLineas: 1 })]);
    (http.getBinario as jest.Mock).mockResolvedValue(gz(roto));
    await expect(scraper.detalle('202601', 'COMPRA', 33)).rejects.toThrow(/formato del CSV del SII cambió/);
  });
});
