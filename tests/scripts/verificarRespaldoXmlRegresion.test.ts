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

describe('ejecutarModoUnaConsulta (regresión del modo de siempre)', () => {
  // `jest.isolateModules` en vez de reasignar `process.env`: aísla el
  // registro de módulos para este `require`, así que las variables VERIF_*
  // que fija cada test no se filtran a otro archivo ni sobreviven al test.
  const ORIG_VERIF_PLAN = process.env.VERIF_PLAN;
  const ORIG_TIPO_DTE = process.env.VERIF_TIPO_DTE;
  const ORIG_FOLIO = process.env.VERIF_FOLIO;
  const ORIG_FOLIO_HASTA = process.env.VERIF_FOLIO_HASTA;

  beforeEach(() => {
    delete process.env.VERIF_PLAN;
    process.env.VERIF_TIPO_DTE = '33';
    process.env.VERIF_FOLIO = '100';
    process.env.VERIF_FOLIO_HASTA = '101';
    (globalThis as any).__capturado = undefined;
  });

  afterAll(() => {
    const restaurar = (clave: string, valor: string | undefined) => {
      if (valor === undefined) delete process.env[clave]; else process.env[clave] = valor;
    };
    restaurar('VERIF_PLAN', ORIG_VERIF_PLAN);
    restaurar('VERIF_TIPO_DTE', ORIG_TIPO_DTE);
    restaurar('VERIF_FOLIO', ORIG_FOLIO);
    restaurar('VERIF_FOLIO_HASTA', ORIG_FOLIO_HASTA);
  });

  it('sigue calculando RESPETADO para tipo_dte+folio, igual que antes del refactor', async () => {
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });

    let ejecutarModoUnaConsulta!: () => Promise<void>;
    jest.isolateModules(() => {
      ({ ejecutarModoUnaConsulta } = require('../../src/scripts/verificarRespaldoXml'));
    });
    await ejecutarModoUnaConsulta();

    expect(logs.some(l => l.includes('2 documentos en 1 tramo'))).toBe(true);
    expect(logs.some(l => /tipo_dte\+folio\/contraparte: RESPETADO/.test(l))).toBe(true);

    const capturado = (globalThis as any).__capturado as Record<string, unknown>;
    expect(capturado.origen).toBe('recibidos');
    expect(capturado.tipo_dte).toBe(33);
    expect(capturado.folio_desde).toBe(100);
    expect(capturado.folio_hasta).toBe(101);
  });

  it('propaga VERIF_MAX_TRAMOS al body de la ruta', async () => {
    process.env.VERIF_MAX_TRAMOS = '20';
    try {
      let ejecutarModoUnaConsulta!: () => Promise<void>;
      jest.isolateModules(() => {
        ({ ejecutarModoUnaConsulta } = require('../../src/scripts/verificarRespaldoXml'));
      });
      await ejecutarModoUnaConsulta();

      const capturado = (globalThis as any).__capturado as Record<string, unknown>;
      expect(capturado.max_tramos).toBe(20);
    } finally {
      delete process.env.VERIF_MAX_TRAMOS;
    }
  });
});
