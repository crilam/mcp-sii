import * as fs from 'fs';
import * as path from 'path';
import { RentaScraper } from '../../src/scrapers/renta';
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
  return { http, session, scraper: new RentaScraper(http, session) };
}

describe('RentaScraper.estadoDeclaracion', () => {
  it('consulta buscaDeclVgte con el RUT partido y el año como cadena', async () => {
    const { http, scraper } = makeScraper(fixture('renta-decl-vigente.json'));

    await scraper.estadoDeclaracion(2025);

    const [, namespace, metodo, data] = (http.postSdi as jest.Mock).mock.calls[0];
    expect(namespace).toBe(
      'cl.sii.sdi.lob.renta.consultaestadof22.data.api.interfaces.FacadeService'
    );
    expect(metodo).toBe('buscaDeclVgte');
    // El servicio quiere el RUT sin dígito verificador y el dv aparte.
    expect(data).toEqual({ rut: '11111111', dv: '1', periodo: '2025' });
  });

  it('parsea las declaraciones del año', async () => {
    const { scraper } = makeScraper(fixture('renta-decl-vigente.json'));

    const estado = await scraper.estadoDeclaracion(2025);

    expect(estado.sinDatos).toBe(false);
    expect(estado.declaraciones).toHaveLength(2);
    expect(estado.declaraciones[0]).toMatchObject({
      folio: 900000001,
      periodo: '2025',
      vigente: true,
      estadoCodigo: 'IPG',
      contribuyente: 'JUAN ANDRES PEREZ SOTO',
      comuna: 'COMUNA EJEMPLO',
      fechaVencimiento: '30/04/2025',
    });
    // Sólo una del año está vigente.
    expect(estado.declaraciones[1].vigente).toBe(false);
  });

  // El SII concatena literales "null" en la dirección cuando falta un
  // componente; exponerlo así parece un bug del servidor MCP.
  it('limpia los "null" que el SII concatena en la dirección', async () => {
    const { scraper } = makeScraper(fixture('renta-decl-vigente.json'));

    const estado = await scraper.estadoDeclaracion(2025);

    expect(estado.declaraciones[0].direccion).toBe('CALLE EJEMPLO 123');
  });

  // Las glosas son el texto que explica el estado: lo más útil para el usuario.
  it('conserva las glosas que explican el estado', async () => {
    const { scraper } = makeScraper(fixture('renta-decl-vigente.json'));

    const estado = await scraper.estadoDeclaracion(2025);

    expect(estado.glosas).toHaveLength(2);
    expect(estado.glosas[0].codigoConclusion).toBe('1100008');
    expect(estado.glosas[0].descripcion).toMatch(/inconsistencias/);
  });

  it('parsea una declaración con devolución', async () => {
    const { scraper } = makeScraper(fixture('renta-decl-devolucion.json'));

    const estado = await scraper.estadoDeclaracion(2010);

    expect(estado.declaraciones[0]).toMatchObject({
      folio: 900000002,
      estadoCodigo: 'ODT',
      remanenteSolicitado: 100000,
      remanenteDevuelto: 100000,
    });
    expect(estado.glosas[0].descripcion).toMatch(/devolución total/);
  });

  // Un año sin declaración responde igual que una consulta correcta que no
  // encontró nada: es un vacío legítimo, no una falla.
  it('trata respCod 2 con data null como un año sin declaración', async () => {
    const { scraper } = makeScraper({ data: null, respCod: 2 });

    const estado = await scraper.estadoDeclaracion(1999);

    expect(estado.sinDatos).toBe(true);
    expect(estado.declaraciones).toEqual([]);
    expect(estado.glosas).toEqual([]);
  });

  // "Acceso no autorizado!" es el sobre mal armado, no un problema de permisos.
  it('distingue un error real del vacío legítimo', async () => {
    const { scraper } = makeScraper({ errorMsg: 'Acceso no autorizado!' });

    await expect(scraper.estadoDeclaracion(2025))
      .rejects.toThrow(/Acceso no autorizado/);
  });

  // Sin data y sin el código de "sin datos" no se puede afirmar que el año esté
  // vacío: reportarlo como vacío escondería un error.
  it('no reporta como vacío una respuesta que no se entiende', async () => {
    const { scraper } = makeScraper({ data: null, respCod: 99 });

    await expect(scraper.estadoDeclaracion(2025)).rejects.toThrow(/inesperada/);
  });

  // La consulta va por HTTP: sin cookie jar está condenada, y preguntarlo antes
  // evita abrir en el SII una sesión que no se va a poder usar.
  it('falla antes de consultar si la sesión no puede entregar el cookie jar', async () => {
    const { http, scraper, session } = makeScraper(fixture('renta-decl-vigente.json'));
    (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {
      throw new Error('requiere certificado');
    });

    await expect(scraper.estadoDeclaracion(2025)).rejects.toThrow(/certificado/);
    expect(http.postSdi).not.toHaveBeenCalled();
  });
});

describe('RentaScraper.f22Completo', () => {
  it('parsea el formulario completo', async () => {
    const { scraper } = makeScraper(fixture('renta-f22-completo.json'));

    const f22 = await scraper.f22Completo(2025, 900000001);

    expect(f22.sinDatos).toBe(false);
    expect(f22.folio).toBe(900000001);
    expect(f22.lineas).toHaveLength(76);
    expect(f22.lineas[0]).toEqual({
      codigo: 1,
      valor: 'PEREZ',
      glosa: 'Primer Apellido/ Razón Social',
    });
  });

  it('consulta f22Completo con folio y periodo', async () => {
    const { http, scraper } = makeScraper(fixture('renta-f22-completo.json'));

    await scraper.f22Completo(2025, 900000001);

    const [, , metodo, data] = (http.postSdi as jest.Mock).mock.calls[0];
    expect(metodo).toBe('f22Completo');
    expect(data).toEqual({
      rut: '11111111', dv: '1', folio: '900000001', periodo: '2025',
    });
  });

  // Sin folio, se resuelve desde la declaración vigente del año.
  it('resuelve el folio desde la declaración vigente si no se lo pasan', async () => {
    const { http, scraper } = makeScraper(null);
    (http.postSdi as jest.Mock).mockImplementation(async (_b, _n, metodo) =>
      metodo === 'buscaDeclVgte'
        ? fixture('renta-decl-vigente.json')
        : fixture('renta-f22-completo.json')
    );

    const f22 = await scraper.f22Completo(2025);

    expect(f22.folio).toBe(900000001);
    expect(f22.lineas).toHaveLength(76);
  });

  // Devolver un formulario vacío haría pasar por "año sin datos" lo que en
  // realidad es "no se pudo resolver el folio".
  it('falla pidiendo el folio si el año no tiene declaración vigente', async () => {
    const { scraper } = makeScraper({ data: null, respCod: 2 });

    await expect(scraper.f22Completo(2025)).rejects.toThrow(/folio explícito/);
  });

  it('trata respCod 2 con data null como formulario sin datos', async () => {
    const { scraper } = makeScraper({ data: null, respCod: 2 });

    const f22 = await scraper.f22Completo(2025, 900000001);

    expect(f22.sinDatos).toBe(true);
    expect(f22.lineas).toEqual([]);
  });
});
