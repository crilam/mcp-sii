import { uf, numeroChileno } from '../../src/scrapers/indicadores';
import { LimiteDeConsultasSii, RecursoNoEncontrado } from '../../src/erroresConsulta';

// `bajar()` no se exporta: se ejercita a través de `uf`, que es la ruta real.
const fetchMock = jest.fn();
const original = global.fetch;

function respuesta(status: number, cuerpo: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(cuerpo, 'latin1'),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => { global.fetch = original; });

describe('bajada de páginas de indicadores', () => {
  // Un año que el SII no publica es un 404 de esa página. Devolver un array vacío
  // lo haría indistinguible de "el año existe y no tiene valores".
  it('un 404 del SII es NO_ENCONTRADO', async () => {
    fetchMock.mockResolvedValue(respuesta(404, '<html>no existe</html>'));

    await expect(uf(1991)).rejects.toBeInstanceOf(RecursoNoEncontrado);
  });

  // El corte por volumen también llega acá: no hay credencial, pero el SII cuenta
  // las requests igual. Tiene que ser su propio error para que el consumidor sepa
  // que hay que ESPERAR, no reintentar.
  it('la página de corte por volumen es LimiteDeConsultasSii', async () => {
    fetchMock.mockResolvedValue(
      respuesta(200, '<html><body>Ha superado el límite de consultas</body></html>'));

    await expect(uf(2025)).rejects.toBeInstanceOf(LimiteDeConsultasSii);
  });

  // Los meses se indexan por nombre, y los nombres vienen con acentos en latin1.
  // Decodificar como UTF-8 rompe "Diciembre"/"Septiembre" y la página entera
  // devuelve cero filas, en silencio.
  it('decodifica en latin1, no en UTF-8', async () => {
    const html = '<h2>Septiembre</h2><table><tr><td>1</td><td>38.384,41</td></tr></table>';
    fetchMock.mockResolvedValue(respuesta(200, html));

    await expect(uf(2025)).resolves.toEqual([{ mes: 9, dia: 1, valor: 38384.41 }]);
  });

  it('se anuncia como navegador y no como script', async () => {
    fetchMock.mockResolvedValue(respuesta(200, '<html></html>'));

    await uf(2025);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/Mozilla/);
  });
});

// El SII escribe los montos con punto de miles y coma decimal, pero el dólar usa
// PUNTO decimal (`928.16`). Los dos formatos conviven en el mismo dominio, y
// tratar uno como el otro da 92816 o 928 mil: plausible en magnitud y mal.
describe('numeroChileno', () => {
  it.each([
    ['$ 39.643,59', 39643.59],
    ['928.16', 928.16],
    ['928,16', 928.16],
    ['67.429', 67429],
    ['-0,2', -0.2],
    ['0,04', 0.04],
    ['-.-', null],
    ['', null],
    ['&nbsp;', null],
  ])('%s -> %p', (texto, esperado) => {
    expect(numeroChileno(texto)).toBe(esperado);
  });

  // Tres decimales con punto se leen como MILES: `1.234` es mil doscientos
  // treinta y cuatro en las tablas del SII. Queda fijado acá porque es la
  // decisión ambigua del parser, y un cambio de criterio tiene que romper algo.
  it('un punto con tres dígitos detrás es separador de miles', () => {
    expect(numeroChileno('1.234')).toBe(1234);
  });
});
