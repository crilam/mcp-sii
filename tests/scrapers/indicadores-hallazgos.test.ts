import { uf, utm } from '../../src/scrapers/indicadores';
import { LimiteDeConsultasSii } from '../../src/erroresConsulta';

// Hallazgos del code review del PR #63. Los tres que cubre este archivo son de
// la misma familia: el parser devuelve algo plausible cuando debería gritar, o
// grita cuando el dato estaba bien. Ninguno lo detecta una validación de forma.
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

describe('falso positivo del corte por volumen', () => {
  // El corte del SII se anuncia arriba de todo, en su página de error. Buscar la
  // marca en el documento ENTERO convierte cualquier página de datos que
  // mencione la frase —una nota al pie sobre límites de consultas -- en un
  // LIMITE_SII falso: el consumidor se queda esperando minutos por datos que sí
  // estaban.
  it('una página CON datos que menciona el límite al pie no es corte', async () => {
    const html =
      '<html><body>' +
      '<h2>Enero</h2><table><tr><td>1</td><td>38.384,41</td></tr></table>' +
      '<p>Nota: si ha superado el límite de consultas diarias, intente mañana.</p>' +
      '</body></html>';
    fetchMock.mockResolvedValue(respuesta(200, html));

    await expect(uf(2025)).resolves.toEqual([{ mes: 1, dia: 1, valor: 38384.41 }]);
  });

  // La contracara, que tiene que seguir funcionando: la página de corte real no
  // trae tablas de mes y anuncia el error al principio.
  it('la página de corte real sigue siendo LimiteDeConsultasSii', async () => {
    fetchMock.mockResolvedValue(
      respuesta(200, '<html><body><h1>Error 429</h1><p>Se ha superado el límite.</p></body></html>'));

    await expect(uf(2025)).rejects.toBeInstanceOf(LimiteDeConsultasSii);
  });
});

describe('silencio del parser cuando no reconoce las tablas', () => {
  // Si el SII rediseña la página y los meses dejan de venir en h2/h3, el parser
  // no encuentra ningún bloque y devuelve []. El consumidor lee esa lista vacía
  // como "el SII no publicó estos valores", que es una afirmación FALSA sobre
  // los datos del SII. Tiene que fallar ruidosamente, como ya hace el parser de
  // los tramos de impuesto.
  it('una página sin tablas de mes reconocibles falla, no devuelve vacío', async () => {
    const html =
      '<html><body><h4>Enero</h4>' +
      '<table><tr><td>1</td><td>38.384,41</td></tr></table></body></html>';
    fetchMock.mockResolvedValue(respuesta(200, html));

    await expect(uf(2025)).rejects.toThrow(/no se reconocieron/i);
  });

  // En las mensuales el diagnóstico se separa en dos: sin tablas es "no se
  // reconocieron las tablas"; CON tablas pero sin filas parseables, el problema
  // está en las celdas y el mensaje tiene que decir eso. Mandar a mirar los
  // encabezados, que están perfectos, es hacer perder el tiempo a quien
  // diagnostica.
  it('vale también para las tablas mensuales (UTM, corrección monetaria)', async () => {
    fetchMock.mockResolvedValue(
      respuesta(200, '<html><body><h4>Enero</h4><table><tr><td>1</td></tr></table></body></html>'));

    await expect(utm(2025)).rejects.toThrow(/ninguna fila de mes reconocible/i);
  });

  it('una página mensual sin ninguna tabla dice que no se reconocieron las tablas', async () => {
    fetchMock.mockResolvedValue(respuesta(200, '<html><body>sin datos</body></html>'));

    await expect(utm(2025)).rejects.toThrow(/no se reconocieron/i);
  });
});

describe('causa del error de conexión', () => {
  // Colapsar toda excepción no-timeout en "falló la conexión" borra la causa: un
  // DNS roto y un TLS vencido se ven idénticos en los logs, y el que opera no
  // tiene por dónde empezar.
  it('conserva la causa original del fallo', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND www.sii.cl'));

    await expect(uf(2025)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'getaddrinfo ENOTFOUND www.sii.cl' }),
    });
  });
});
