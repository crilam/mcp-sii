import { registrarRutasMipyme } from '../../../src/rest/rutas/mipyme';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/mipyme';

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

  it('registra las 7 rutas bajo /v1/mipyme', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/mipyme/list-empresas', 'POST /v1/mipyme/list-dte-emitidos',
      'POST /v1/mipyme/list-dte-recibidos', 'POST /v1/mipyme/dte-pdf',
      'POST /v1/mipyme/list-borradores', 'POST /v1/mipyme/emitir-dte',
      'POST /v1/mipyme/borrador',
    ]);
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
