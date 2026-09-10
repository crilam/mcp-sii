import { registrarRutasMipyme } from '../../../src/rest/rutas/mipyme';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/mipyme';
import { PortalSiiNoDisponible } from '../../../src/erroresConsulta';

jest.mock('../../../src/core/mipyme');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasMipyme(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

const LINEA_MINIMA = { descripcion: 'Item', cantidad: 1, precio_unitario: 1000 };
const RECEPTOR_MINIMO = {
  receptor_rut: '33333333', receptor_dv: '1', receptor_razon_social: 'Test',
  receptor_giro: 'Giro', receptor_direccion: 'Calle 1', receptor_comuna: 'Santiago', receptor_ciudad: 'Santiago',
};

describe('registrarRutasMipyme', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 8 rutas bajo /v1/mipyme', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/mipyme/list-empresas', 'POST /v1/mipyme/list-dte-emitidos',
      'POST /v1/mipyme/list-dte-recibidos', 'POST /v1/mipyme/dte-pdf',
      'POST /v1/mipyme/respaldo-xml',
      'POST /v1/mipyme/list-borradores', 'POST /v1/mipyme/emitir-dte',
      'POST /v1/mipyme/borrador',
    ]);
  });

  describe('respaldo-xml', () => {
    const BASE = { rut: '11.111.111-1', clave: 'secreta', fecha_desde: '2026-08-01', fecha_hasta: '2026-08-31' };
    const RESULTADO = {
      empresaRut: '44444444-4', origen: 'RCP' as const,
      fechaDesde: '2026-08-01', fechaHasta: '2026-08-31', documentos: 2,
      tramos: [{ fechaDesde: '2026-08-01', fechaHasta: '2026-08-31', documentos: 2, xml: '<SetDTE></SetDTE>' }],
      limitaciones: [],
    };

    it('devuelve el XML crudo, sin base64', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue(RESULTADO);

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      const body = r.body as any;
      expect(body.ok).toBe(true);
      expect(body.tramos[0].xml).toBe('<SetDTE></SetDTE>');
      expect(body.content_type).toBe('application/xml');
      expect(body.documentos).toBe(2);
      expect(JSON.stringify(body)).not.toContain('base64');
    });

    // El default es `recibidos` porque es el caso que motiva la ruta: clasificar
    // gastos del libro de compras.
    it('traduce origen a los valores del portal y usa recibidos por defecto', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue(RESULTADO);
      const rutas = armarRouter();

      await rutas.get('POST /v1/mipyme/respaldo-xml')!(BASE);
      expect(core.respaldoXml).toHaveBeenCalledWith(
        expect.anything(), '11.111.111-1', expect.objectContaining({ origen: 'RCP' }));

      await rutas.get('POST /v1/mipyme/respaldo-xml')!({ ...BASE, origen: 'emitidos' });
      expect(core.respaldoXml).toHaveBeenLastCalledWith(
        expect.anything(), '11.111.111-1', expect.objectContaining({ origen: 'ENV' }));
    });

    it('exige el rango de fechas', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!({ rut: '11.111.111-1', clave: 'x' });
      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('rechaza una fecha con formato distinto de YYYY-MM-DD', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!({ ...BASE, fecha_desde: '01-08-2026' });
      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    // Un rango al revés es error de quien pide, no del servicio: si llegara al
    // scraper saldría como Error genérico, y `ejecutar` lo devuelve como 200 con
    // error:"ERROR" y sin detalle — o sea "reintentá", que acá nunca funciona.
    it('rechaza con 400 un rango invertido, sin llamar al SII', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(
        { ...BASE, fecha_desde: '2026-08-31', fecha_hasta: '2026-08-01' });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('rechaza con 400 una fecha que no existe en el calendario', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(
        { ...BASE, fecha_desde: '2026-02-31' });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('pasa los filtros nuevos al core', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue(RESULTADO);

      await armarRouter().get('POST /v1/mipyme/respaldo-xml')!({
        ...BASE, contraparte_rut: '77777777-7', razon_social: 'Proveedor',
        folio_desde: 10, folio_hasta: 20,
      });

      expect(core.respaldoXml).toHaveBeenCalledWith(
        expect.anything(), '11.111.111-1',
        expect.objectContaining({
          contraparteRut: '77777777-7', razonSocial: 'Proveedor',
          folioDesde: 10, folioHasta: 20,
        }));
    });

    // Un RUT basura no falla en el portal: devuelve CERO documentos, y un
    // respaldo vacío se lee igual que "este período no tuvo documentos". Por eso
    // se rechaza acá en vez de dejarlo pasar.
    it('rechaza una contraparte que no es un RUT', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(
        { ...BASE, contraparte_rut: 'Banchile Corredores' });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('acepta la contraparte con puntos y con o sin dígito verificador', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue(RESULTADO);
      const rutas = armarRouter();

      await rutas.get('POST /v1/mipyme/respaldo-xml')!({ ...BASE, contraparte_rut: '77.777.777-7' });
      expect(core.respaldoXml).toHaveBeenLastCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ contraparteRut: '77777777-7' }));

      await rutas.get('POST /v1/mipyme/respaldo-xml')!({ ...BASE, contraparte_rut: '77777777' });
      expect(core.respaldoXml).toHaveBeenLastCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ contraparteRut: '77777777' }));
    });

    // Un DV que no corresponde está BIEN FORMADO pero no identifica a nadie: el
    // portal devuelve cero documentos, que es el mismo silencio de siempre.
    it('rechaza un RUT con dígito verificador incorrecto', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(
        { ...BASE, contraparte_rut: '77777777-3' });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('rechaza una razón social vacía o de puros espacios', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!({ ...BASE, razon_social: '   ' });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    // `folio_hasta` solo dejaría el rango a medias: el portal manda los dos
    // extremos. Se rechaza en vez de inventarle un inicio.
    it('rechaza folio_hasta sin folio_desde', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!({ ...BASE, folio_hasta: 20 });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('rechaza un rango de folios invertido', async () => {
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(
        { ...BASE, folio_desde: 20, folio_hasta: 10 });

      expect(r.status).toBe(400);
      expect(core.respaldoXml).not.toHaveBeenCalled();
    });

    it('nombra cada tramo con la empresa y su rango', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue(RESULTADO);

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      expect((r.body as any).tramos[0].nombre_archivo)
        .toBe('mipyme-respaldo-recibidos-444444444-2026-08-01-2026-08-31.xml');
    });

    // El consumidor (agenticerp) decide si tiene un respaldo PARCIAL mirando
    // este campo: tiene que venir en snake_case, como el resto del contrato.
    it('expone las limitaciones en snake_case, con lista vacía cuando no hubo', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue(RESULTADO);
      const r1 = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);
      expect((r1.body as any).limitaciones).toEqual([]);

      // El motivo es de DÍA SUELTO ("El día X tiene más de 20 documentos"), así
      // que el rango de la fixture tiene que ser ESE día y no un tramo de
      // varios: un motivo de día con un rango de dos semanas es un fixture
      // inconsistente que ningún caso real produce (el troceo por fecha nunca
      // deja un motivo de día suelto cubriendo más de un día).
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        tramos: [{ fechaDesde: '2026-08-01', fechaHasta: '2026-08-16', documentos: 2, xml: '<SetDTE></SetDTE>' }],
        limitaciones: [
          { fechaDesde: '2026-08-17', fechaHasta: '2026-08-17', motivo: 'El día 2026-08-17 tiene más de 20 documentos.' },
        ],
      });
      const r2 = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);
      const body2 = r2.body as any;
      expect(body2.ok).toBe(true);
      expect(body2.limitaciones).toEqual([
        { fecha_desde: '2026-08-17', fecha_hasta: '2026-08-17', motivo: 'El día 2026-08-17 tiene más de 20 documentos.' },
      ]);
    });

    // Los campos del tercer nivel de troceo (folio para emitidos, contraparte
    // para recibidos) tienen que llegar en snake_case, igual que el resto del
    // contrato: son lo que le permite a agenticerp reconstruir el pedido sin
    // parsear el texto de `motivo`.
    it('expone tipo_dte, contraparte_rut, razon_social y el rango de folio de una limitación del tercer nivel', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        tramos: [{ fechaDesde: '2026-08-01', fechaHasta: '2026-08-16', documentos: 2, xml: '<SetDTE></SetDTE>' }],
        limitaciones: [
          {
            fechaDesde: '2026-08-17', fechaHasta: '2026-08-17',
            tipoDte: 33, contraparteRut: '77777777-7', razonSocial: 'Muñoz', folioDesde: 100, folioHasta: 100,
            motivo: 'El folio 100 del 2026-08-17 (contraparte 77777777-7) excede por sí solo el tope.',
          },
        ],
      });
      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);
      const body = r.body as any;
      expect(body.limitaciones[0]).toMatchObject({
        tipo_dte: 33, contraparte_rut: '77777777-7', razon_social: 'Muñoz', folio_desde: 100, folio_hasta: 100,
      });
    });

    // Espejo del test anterior: cuando el motivo NO sale del tercer nivel
    // (día lleno sin `tipo_dte`, o tope de `max_tramos` genérico), los cinco
    // campos son `undefined` en el objeto que arma la ruta — y `undefined`
    // sólo es "ausente" cuando de verdad se serializa a JSON (que es lo que
    // hace `responderJson` con `JSON.stringify`, no lo que devuelve el
    // `RutaHandler` en memoria). Sin este round-trip, un objeto con
    // `tipo_dte: undefined` pasaría el test igual y el body real por HTTP
    // podría llegar con `"tipo_dte":null` si algún día la serialización
    // cambia (p.ej. un `JSON.stringify` con replacer, o un paso intermedio
    // que no preserve `undefined`).
    it('omite tipo_dte/contraparte_rut/razon_social/folio_desde/folio_hasta del JSON cuando el motivo no es del tercer nivel', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        limitaciones: [
          { fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', motivo: 'El día 2026-08-01 tiene más de 20 documentos y el SII no entrega más por descarga. Pedí ese día con tipo_dte.' },
        ],
      });

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);
      // El round-trip de verdad: lo que `responderJson` manda por HTTP.
      const porHttp = JSON.parse(JSON.stringify(r.body));

      expect(Object.keys(porHttp.limitaciones[0]).sort()).toEqual(['fecha_desde', 'fecha_hasta', 'motivo']);
    });

    // Cuando NO se bajó nada —todos los sub-rangos toparon, o el único tramo
    // pedido topó y no había hermanos— un ok:true con tramos:[] sería
    // indistinguible de "el período no tuvo documentos". La ruta sigue
    // respondiendo ok:false/LIMITE_CONOCIDO, igual que antes de que el scraper
    // dejara de lanzar.
    it('responde ok:false LIMITE_CONOCIDO cuando ningún sub-rango se pudo bajar', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        documentos: 0,
        tramos: [],
        limitaciones: [
          { fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', motivo: 'El día 2026-08-01 tiene más de 20 documentos y el SII no entrega más por descarga. Pedí ese día con tipo_dte.' },
        ],
      });

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      expect(r.status).toBe(200);
      const body = r.body as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('LIMITE_CONOCIDO');
      expect(body.detalle).toMatch(/2026-08-01.*tipo_dte|tipo_dte.*2026-08-01/s);
    });

    // El bug real: el portal devolvió su página de error transitoria y el
    // scraper la propaga como PortalSiiNoDisponible en vez de absorberla en
    // una limitación. La ruta tiene que traducirla a SII_NO_DISPONIBLE, no a
    // LIMITE_CONOCIDO (que el contrato declara permanente) ni a ERROR mudo.
    it('responde ok:false SII_NO_DISPONIBLE cuando el portal devolvió su página de error', async () => {
      (core.respaldoXml as jest.Mock).mockRejectedValue(
        new PortalSiiNoDisponible(
          'El portal mipyme respondió con su página de error (código 04.77.113.29.408.51).'
        )
      );

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      expect(r.status).toBe(200);
      const body = r.body as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('SII_NO_DISPONIBLE');
      expect(body.detalle).toMatch(/04\.77\.113\.29\.408\.51/);
    });

    // El `detalle` de varias limitaciones se junta con ' | ' y no con '\n':
    // los demás `detalle` de este servicio son de una sola línea, y un salto
    // acá rompería esa uniformidad.
    it('junta varias limitaciones en el detalle con " | ", no con salto de línea', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        documentos: 0,
        tramos: [],
        limitaciones: [
          { fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', motivo: 'Motivo uno.' },
          { fechaDesde: '2026-08-02', fechaHasta: '2026-08-02', motivo: 'Motivo dos.' },
        ],
      });

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      const body = r.body as any;
      expect(body.detalle).toBe(
        '2026-08-01..2026-08-01: Motivo uno. | 2026-08-02..2026-08-02: Motivo dos.');
      expect(body.detalle).not.toContain('\n');
    });

    // El tope de folio único del tercer nivel (ver `TOPE_FOLIOS_UNICOS_POR_DIA`
    // en mipymeHttp.ts) es lo que evita que este `detalle` llegue a medir los
    // ~5.6 KB que un día de 45 folios sin ese tope produciría (24 limitaciones
    // casi idénticas). Acá se simula el escenario YA acotado por el scraper
    // (12 limitaciones, 10 individuales + 2 colapsadas) para verificar que la
    // ruta no vuelve a inflar el `detalle` por su cuenta.
    it('el detalle queda acotado incluso con muchas limitaciones de folio único (tope del tercer nivel)', async () => {
      const individuales = Array.from({ length: 10 }, (_, i) => ({
        fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33, folioDesde: i + 1, folioHasta: i + 1,
        motivo:
          `El folio ${i + 1} del 2026-08-05 excede por sí solo el tope de 20 documentos del SII: es un `
          + `único folio y el filtro ya no se puede afinar más. El listado y la descarga no cuentan `
          + `igual para este caso puntual.`,
      }));
      const colapsadas = [
        {
          fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33, folioDesde: 11, folioHasta: 20,
          motivo:
            'El respaldo de 33333333-3 acumuló más de 10 folios que exceden por sí solos el tope del '
            + '2026-08-05: se corta acá para no seguir intentando descargas condenadas. Los folios '
            + '11..20 (rango envolvente de los pendientes, puede incluir folios ya bajados o de otro '
            + 'tipo) quedaron sin bajar. Si esto se repite, revisá si el SII está respetando el filtro '
            + 'de folio antes de seguir con RESPALDO_XML_TERCER_NIVEL prendido.',
        },
        {
          fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33, folioDesde: 21, folioHasta: 45,
          motivo:
            'El respaldo de 33333333-3 acumuló más de 10 folios que exceden por sí solos el tope del '
            + '2026-08-05: se corta acá para no seguir intentando descargas condenadas. Los folios '
            + '21..45 (rango envolvente de los pendientes, puede incluir folios ya bajados o de otro '
            + 'tipo) quedaron sin bajar. Si esto se repite, revisá si el SII está respetando el filtro '
            + 'de folio antes de seguir con RESPALDO_XML_TERCER_NIVEL prendido.',
        },
      ];
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        documentos: 0,
        tramos: [],
        limitaciones: [...individuales, ...colapsadas],
      });

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      const body = r.body as any;
      expect(body.error).toBe('LIMITE_CONOCIDO');
      // Muy por debajo de los ~5.6 KB que 24 limitaciones sin tope medían.
      expect(body.detalle.length).toBeLessThan(4000);
    });

    // La condición de "nada bajado" depende de esta distinción: `tramos:[]`
    // SIN limitaciones es un período sin documentos, y tiene que seguir siendo
    // ok:true. Si la ruta disparara LIMITE_CONOCIDO acá, un mes real sin DTE
    // sería indistinguible de un corte del SII.
    it('un período sin documentos (tramos:[] y limitaciones:[]) sigue siendo ok:true', async () => {
      (core.respaldoXml as jest.Mock).mockResolvedValue({
        ...RESULTADO,
        documentos: 0,
        tramos: [],
        limitaciones: [],
      });

      const r = await armarRouter().get('POST /v1/mipyme/respaldo-xml')!(BASE);

      expect(r.status).toBe(200);
      const body = r.body as any;
      expect(body.ok).toBe(true);
      expect(body.tramos).toEqual([]);
      expect(body.limitaciones).toEqual([]);
      expect(body.documentos).toBe(0);
    });
  });

  describe('borrador (R11)', () => {
    const CRED = { rut: '11.111.111-1', clave: 'secreta', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO };

    // A diferencia de emitir-dte, el borrador ACEPTA CLAVE (no firma) y SÍ
    // soporta confirmar:true.
    it('sin confirmar simula y audita como simulado', async () => {
      (core.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: false, resumen: {}, borradorId: null });
      const r = await armarRouter().get('POST /v1/mipyme/borrador')!(CRED);
      expect((r.body as any).ok).toBe(true);
      expect(r.auditoria).toMatchObject({ efecto: 'simulado' });
      expect(r.auditoria!.referencia).toMatch(/^borrador:33-33333333-[0-9a-f]{8}$/);
      expect(core.guardarBorrador).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), false, undefined);
    });

    it('con confirmar:true guarda y audita como ejecutado con el id', async () => {
      (core.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: true, resumen: {}, borradorId: '998877' });
      const r = await armarRouter().get('POST /v1/mipyme/borrador')!({ ...CRED, confirmar: true });
      expect(r.auditoria).toEqual({ efecto: 'ejecutado', referencia: 'borrador:998877' });
      expect(core.guardarBorrador).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), true, undefined);
    });

    it('borrador_id se pasa al core para editar', async () => {
      (core.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: true, resumen: {}, borradorId: '555' });
      await armarRouter().get('POST /v1/mipyme/borrador')!({ ...CRED, confirmar: true, borrador_id: '555' });
      expect(core.guardarBorrador).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), true, '555');
    });

    // Un bloqueo anti-doble-click (LimitacionConocida → LIMITE_CONOCIDO) NO se
    // audita como escritura: no se tocó el SII.
    it('un bloqueo por doble-click (LIMITE_CONOCIDO) no deja traza de escritura', async () => {
      (core.guardarBorrador as jest.Mock).mockRejectedValue(new (require('../../../src/erroresConsulta').LimitacionConocida)('ya en curso'));
      const r = await armarRouter().get('POST /v1/mipyme/borrador')!({ ...CRED, confirmar: true });
      expect((r.body as any).error).toBe('LIMITE_CONOCIDO');
      expect(r.auditoria).toBeUndefined();
    });

    // Un confirmar:true que FALLA (rechazo del SII) se audita como 'fallido'.
    it('un guardado fallido (confirmar:true) se audita como fallido', async () => {
      (core.guardarBorrador as jest.Mock).mockRejectedValue(new (require('../../../src/erroresConsulta').EscrituraRechazadaPorSii)('no se guardó'));
      const r = await armarRouter().get('POST /v1/mipyme/borrador')!({ ...CRED, confirmar: true });
      expect((r.body as any).ok).toBe(false);
      expect(r.auditoria).toMatchObject({ efecto: 'fallido' });
      expect(r.auditoria!.referencia).toMatch(/^borrador:33-33333333-[0-9a-f]{8}$/);
    });
  });

  it('list-empresas: body válido llama al core', async () => {
    (core.listEmpresas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, datos: [] } });
  });

  it('emitir-dte con confirmar=false (default) llama al core en modo previsualización', async () => {
    (core.emitirDte as jest.Mock).mockResolvedValue({ emitido: false, resumen: {} });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO,
    });
    expect(respuesta.status).toBe(200);
    expect(core.emitirDte).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), false);
  });

  it('emitir-dte con confirmar=true responde 400 CONFIRMAR_NO_SOPORTADO sin llamar al core', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO, confirmar: true,
    });
    expect(respuesta).toEqual({ status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } });
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
  // Las dos LECTURAS pasaron a aceptar clave tributaria (verificado contra el
  // portal: list-empresas devolvió las cinco empresas de la persona).
  it('list-empresas: acepta clave tributaria', async () => {
    (core.listEmpresas as jest.Mock).mockResolvedValue([{ rut: '1-9', nombre: 'X' }]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut: '11.111.111-1', clave: 'secreta' });

    expect(r).toEqual({ status: 200, body: { ok: true, datos: [{ rut: '1-9', nombre: 'X' }] } });
  });

  it('list-dte-emitidos: acepta clave tributaria', async () => {
    (core.listDteEmitidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-dte-emitidos')!({ rut: '11.111.111-1', clave: 'secreta' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('list-dte-recibidos: acepta clave tributaria', async () => {
    (core.listDteRecibidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
      rut: '11.111.111-1', clave: 'secreta',
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  // El filtro de contraparte del lado recibido es `emisor_rut`. Si la ruta
  // tomara `receptor_rut` por copiar la de emitidos, el filtro se perdería en
  // silencio y la respuesta traería TODO el historial.
  it('list-dte-recibidos: pasa emisor_rut al core como emisorRut', async () => {
    (core.listDteRecibidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
      rut: '11.111.111-1', clave: 'secreta', emisor_rut: '22222222-2', pagina: 2,
    });

    expect(core.listDteRecibidos).toHaveBeenCalledWith(
      expect.anything(), '11.111.111-1',
      expect.objectContaining({ emisorRut: '22222222-2', pagina: 2 }));
  });

  it('list-dte-recibidos: una página inválida es 400 y no llama al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
      rut: '11.111.111-1', clave: 'secreta', pagina: 0,
    });

    expect(r.status).toBe(400);
    expect(core.listDteRecibidos).not.toHaveBeenCalled();
  });

  // El Buffer se envuelve a mano porque `ejecutar` spreadea el resultado, y
  // spreadear un Buffer produce {"0":37,"1":80,...}: un JSON enorme e inservible.
  it('dte-pdf: devuelve el PDF en base64, no el Buffer spreadeado', async () => {
    (core.dtePdf as jest.Mock).mockResolvedValue(Buffer.from('%PDF-1.4 x'));
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/dte-pdf')!({
      rut: '11.111.111-1', clave: 'secreta', codigo: '1897586940',
    });

    expect(r.body).toMatchObject({
      ok: true,
      codigo: '1897586940',
      content_type: 'application/pdf',
      nombre_archivo: 'mipyme-dte-1897586940.pdf',
      tamano_bytes: 10,
      pdf_base64: Buffer.from('%PDF-1.4 x').toString('base64'),
    });
    expect((r.body as Record<string, unknown>)['0']).toBeUndefined();
  });

  // El identificador es el `codigo` del listado. Un folio ("205") también es
  // sólo dígitos y el schema no puede distinguirlos; lo que sí se rechaza es
  // cualquier cosa que no tenga la forma de un identificador del portal.
  it.each(['abc', '', '12-34', '../etc/passwd'])(
    'dte-pdf: rechaza un codigo mal formado (%p) sin llamar al core', async (codigo) => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/mipyme/dte-pdf')!({
        rut: '11.111.111-1', clave: 'secreta', codigo,
      });

      expect(r.status).toBe(400);
      expect(core.dtePdf).not.toHaveBeenCalled();
    });

  it('list-borradores: acepta clave tributaria y envuelve la lista en datos', async () => {
    (core.listBorradores as jest.Mock).mockResolvedValue([
      { codigo: '1', tipoDte: 33, campos: {} },
    ]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-borradores')!({
      rut: '11.111.111-1', clave: 'secreta',
    });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, datos: [{ codigo: '1', tipoDte: 33, campos: {} }] });
  });

  // La emisión NO cambió: firmar un DTE requiere el certificado de verdad, no
  // basta una sesión autenticada. Este test es el que impide que un futuro
  // "unifiquemos todo con conCredencial" habilite firmar con clave.
  it('emitir-dte: rechaza clave tributaria sin llamar al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'secreta', tipo_dte: 33,
      ...RECEPTOR_MINIMO, lineas: [LINEA_MINIMA],
    });

    expect(r.status).toBe(400);
    expect(core.emitirDte).not.toHaveBeenCalled();
  });

  // Y tampoco la mezcla. Sin el rechazo explícito de `clave`, este body pasaba
  // la validación, zod descartaba la clave en silencio y se FIRMABA con el
  // certificado: el caller creía haber usado una credencial y se usó la otra.
  it('emitir-dte: rechaza clave junto con certificado, sin firmar con el certificado', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'secreta',
      certificado_base64: 'eHh4', certificado_password: 'yyy',
      tipo_dte: 33, ...RECEPTOR_MINIMO, lineas: [LINEA_MINIMA],
    });

    expect(r.status).toBe(400);
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
  // `null` no es `undefined`: con `z.undefined()` este body pasaba y se firmaba
  // con el certificado. Un consumidor que serializa sus campos vacíos como null
  // caía justo acá.
  it('emitir-dte: rechaza clave en null junto con certificado', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: null,
      certificado_base64: 'eHh4', certificado_password: 'yyy',
      tipo_dte: 33, ...RECEPTOR_MINIMO, lineas: [LINEA_MINIMA],
    });

    expect(r.status).toBe(400);
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
});
