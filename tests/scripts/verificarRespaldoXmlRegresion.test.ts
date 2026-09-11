// Regresión: el modo de una consulta (las variables VERIF_* de siempre, sin
// VERIF_PLAN) tiene que seguir dando el mismo resultado que antes de este
// cambio — hay comandos ya escritos contra él.
//
// Los dos `jest.mock` van a nivel de MÓDULO (no dentro de un `describe`),
// porque necesitan quedar hoisteados por encima del `import` de
// `verificarRespaldoXml` — ese import ya arrastra `perfilesVerificacion` y
// `rest/rutas/mipyme` de verdad, y mockearlos DESPUÉS de que ese `require` ya
// corrió no tiene efecto.
jest.mock('../../src/perfilesVerificacion', () => ({
  perfil: () => ({
    nombre: 'mipyme',
    rut: '11111111-1',
    credencial: { tipo: 'clave', clave: 'clave-test' },
  }),
  credencialParaBody: () => ({ rut: '11111111-1', clave: 'clave-test' }),
}));

jest.mock('../../src/rest/rutas/mipyme', () => ({
  registrarRutasMipyme: (rutas: Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>) => {
    rutas.set('POST /v1/mipyme/respaldo-xml', async body => {
      (globalThis as any).__capturado = body;
      return {
        status: 200,
        body: {
          ok: true,
          documentos: 2,
          tramos: [{
            nombre_archivo: 'mipyme-respaldo-recibidos-111111111-2026-01-01-2026-01-31.xml',
            fecha_desde: '2026-01-01',
            fecha_hasta: '2026-01-31',
            documentos: 2,
            xml: '<?xml version="1.0"?>\n<SetDTE>'
              + '<Detalle><TipoDTE>33</TipoDTE><Folio>100</Folio><RUTEmisor>77777777-7</RUTEmisor></Detalle>'
              + '<Detalle><TipoDTE>33</TipoDTE><Folio>101</Folio><RUTEmisor>77777777-7</RUTEmisor></Detalle>'
              + '</SetDTE>',
          }],
        },
      };
    });
  },
}));

import { ejecutarModoUnaConsulta } from '../../src/scripts/verificarRespaldoXml';

describe('ejecutarModoUnaConsulta (regresión del modo de siempre)', () => {
  // Reasigna `process.env` entero (no sólo las variables VERIF_*) a propósito:
  // es la única forma de GARANTIZAR que no quede una `VERIF_*` de una corrida
  // manual anterior filtrándose al test. Es seguro porque:
  //   1. Jest corre cada ARCHIVO de test en su propio proceso worker (o, si
  //      reusa el proceso entre archivos, cada uno igual reinicia módulos), así
  //      que esta reasignación no puede afectar a otro archivo de test que ya
  //      haya leído sus variables al importar.
  //   2. `ORIG_ENV` se captura ANTES de tocar nada y `afterAll` lo restaura, así
  //      que al terminar este describe el proceso vuelve a su `process.env` de
  //      partida — ningún test posterior en el MISMO archivo ve una mutación
  //      que sobreviva a un test anterior.
  // Si algún día esto deja de ser seguro (por ejemplo, tests corriendo en el
  // mismo worker en paralelo dentro de este archivo), la alternativa es aislar
  // el módulo con `jest.isolateModules` en vez de tocar el global.
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    delete process.env.VERIF_PLAN;
    process.env.VERIF_TIPO_DTE = '33';
    process.env.VERIF_FOLIO = '100';
    process.env.VERIF_FOLIO_HASTA = '101';
    (globalThis as any).__capturado = undefined;
  });

  afterAll(() => { process.env = ORIG_ENV; });

  it('sigue calculando RESPETADO para tipo_dte+folio, igual que antes del refactor', async () => {
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });

    await ejecutarModoUnaConsulta();

    expect(logs.some(l => l.includes('2 documentos en 1 tramo'))).toBe(true);
    expect(logs.some(l => /tipo_dte\+folio\/contraparte: RESPETADO/.test(l))).toBe(true);

    const capturado = (globalThis as any).__capturado as Record<string, unknown>;
    expect(capturado.origen).toBe('recibidos');
    expect(capturado.tipo_dte).toBe(33);
    expect(capturado.folio_desde).toBe(100);
    expect(capturado.folio_hasta).toBe(101);
  });
});
