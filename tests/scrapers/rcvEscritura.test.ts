import { RcvEscrituraScraper } from '../../src/scrapers/rcvEscritura';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { LimitacionConocida, EscrituraRechazadaPorSii } from '../../src/erroresConsulta';
import { _resetCatalogoAcuse } from '../../src/scrapers/rcvEscritura';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

const CATALOGO = { respEstado: { codRespuesta: 0 }, dataEventosDocs: [
  { dedCodEvento: 'ERM', dedDescEvento: 'Acuse de  Recibo de Mercaderías y Servicios Ley 19.983' },
  { dedCodEvento: 'ERG', dedDescEvento: 'Acuse de Recibo Mercaderías en Guía' },
] };
const DOCS = [{ rutEmisor: '22222222-2', tipoDoc: 33, folio: 100 }];

function armar() {
  const http = new MockHttp({} as any);
  const session = new MockSession({} as any, {} as any);
  (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn();
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { http, session, scraper: new RcvEscrituraScraper(http, session) };
}

beforeEach(() => _resetCatalogoAcuse());

describe('RcvEscrituraScraper.eventosAcuse', () => {
  it('lee el catálogo de dataEventosDocs y normaliza descripciones', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue(CATALOGO);
    const evs = await scraper.eventosAcuse();
    expect(evs).toEqual([
      { codigo: 'ERM', descripcion: 'Acuse de Recibo de Mercaderías y Servicios Ley 19.983' },
      { codigo: 'ERG', descripcion: 'Acuse de Recibo Mercaderías en Guía' },
    ]);
    expect((http.postSdi as jest.Mock).mock.calls[0][2]).toBe('getEventosDoc');
  });
});

describe('RcvEscrituraScraper.acusar', () => {
  // LA barrera: confirmar:false NUNCA llama a ingresarAceptacionReclamoDocs.
  it('confirmar:false simula y NO llama al método de escritura', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue(CATALOGO); // sólo el catálogo

    const r = await scraper.acusar(DOCS, 'ERM', false);

    expect(r.ejecutado).toBe(false);
    const metodos = (http.postSdi as jest.Mock).mock.calls.map(c => c[2]);
    expect(metodos).not.toContain('ingresarAceptacionReclamoDocs');
    expect(metodos).toEqual(['getEventosDoc']); // sólo validó el evento
  });

  it('confirmar:true cursa el acuse con el payload correcto', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock)
      .mockResolvedValueOnce(CATALOGO)
      .mockResolvedValueOnce({ respEstado: { codRespuesta: 0, msgeRespuesta: 'OK' } });

    const r = await scraper.acusar(DOCS, 'ERM', true);

    expect(r.ejecutado).toBe(true);
    const [, , metodo, data] = (http.postSdi as jest.Mock).mock.calls[1];
    expect(metodo).toBe('ingresarAceptacionReclamoDocs');
    expect(data).toEqual({
      dteAcuRe: [{ detRutDoc: '22222222', detDvDoc: '2', detTipoDoc: 33, detNroDoc: 100, dedCodEvento: 'ERM' }],
      rutAutenticado: '11111111', dvAutenticado: '1',
    });
  });

  // Un evento fuera del catálogo NO se manda a ciegas a una escritura.
  it('rechaza un evento que no está en el catálogo, sin escribir', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue(CATALOGO);
    await expect(scraper.acusar(DOCS, 'XXX', true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect((http.postSdi as jest.Mock).mock.calls.map(c => c[2])).not.toContain('ingresarAceptacionReclamoDocs');
  });

  // El código 100 es una alerta del SII: NO se reporta como acuse exitoso.
  it('el código 100 (alerta) es LimitacionConocida, no éxito', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock)
      .mockResolvedValueOnce(CATALOGO)
      .mockResolvedValueOnce({ respEstado: { codRespuesta: 100, msgeRespuesta: 'Ya acusado' } });
    await expect(scraper.acusar(DOCS, 'ERM', true)).rejects.toThrow(/no cursó el acuse: Ya acusado/);
  });

  // Un rechazo de negocio del SII (código != 0 y != 100) es EscrituraRechazada,
  // no un Error genérico que saldría 500 por REST.
  it('un código de rechazo del SII es EscrituraRechazadaPorSii', async () => {
    const { http, scraper } = armar();
    (http.postSdi as jest.Mock)
      .mockResolvedValueOnce(CATALOGO)
      .mockResolvedValueOnce({ respEstado: { codRespuesta: 2, msgeRespuesta: 'RUT sin timbraje' } });
    await expect(scraper.acusar(DOCS, 'ERM', true)).rejects.toBeInstanceOf(EscrituraRechazadaPorSii);
  });

  it('sin documentos falla antes de tocar el SII', async () => {
    const { scraper } = armar();
    await expect(scraper.acusar([], 'ERM', true)).rejects.toThrow(/ningún documento/);
  });
});
