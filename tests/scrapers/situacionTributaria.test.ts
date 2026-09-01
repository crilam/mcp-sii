import {
  parsearSituacionTributaria,
  consultarSituacionTributaria,
  TransporteSituacion,
} from '../../src/scrapers/situacionTributaria';
import { RecursoNoEncontrado, LimitacionConocida } from '../../src/erroresConsulta';

/** Forma real de `getConsultaData` para un contribuyente encontrado (recortada a lo que se usa). */
function respuestaOk(overrides: Record<string, unknown> = {}) {
  return {
    registrado: true,
    nombre: 'EMPRESA DE EJEMPLO SPA',
    inicioActividades: true,
    fechaInicioActividades: '08-07-2016',
    tieneEMTP: true,
    girosNegocio: [
      { codigo: '262000', categoriaTributaria: '1', descripcion: 'FABRICACION DE COMPUTADORES', indicadorAfectoIva: 'S' },
      { codigo: '620200', categoriaTributaria: '2', descripcion: 'CONSULTORIA DE INFORMATICA', indicadorAfectoIva: 'N' },
    ],
    ...overrides,
  };
}

describe('parsearSituacionTributaria', () => {
  it('extrae identificación, inicio de actividades y pro-pyme', () => {
    const sit = parsearSituacionTributaria(respuestaOk(), '22222222-2');
    expect(sit.rut).toBe('22222222-2');
    expect(sit.razonSocial).toBe('EMPRESA DE EJEMPLO SPA');
    expect(sit.inicioActividades).toBe(true);
    expect(sit.fechaInicioActividades).toBe('08-07-2016');
    expect(sit.proPyme).toBe(true);
  });

  it('la API nueva no expone moneda extranjera: siempre null', () => {
    expect(parsearSituacionTributaria(respuestaOk(), '22222222-2').monedaExtranjera).toBeNull();
  });

  it('extrae las actividades: código numérico, categoría 1/2, IVA S/N', () => {
    const sit = parsearSituacionTributaria(respuestaOk(), '22222222-2');
    expect(sit.actividades).toEqual([
      { giro: 'FABRICACION DE COMPUTADORES', codigo: 262000, categoria: 1, afectaIva: true },
      { giro: 'CONSULTORIA DE INFORMATICA', codigo: 620200, categoria: 2, afectaIva: false },
    ]);
  });

  it('sin giros → lista vacía, no explota', () => {
    expect(parsearSituacionTributaria(respuestaOk({ girosNegocio: [] }), '22222222-2').actividades).toEqual([]);
  });

  it('girosNegocio ausente o con forma inesperada (no-array) → lista vacía, no explota', () => {
    expect(parsearSituacionTributaria(respuestaOk({ girosNegocio: undefined }), '22222222-2').actividades).toEqual([]);
    expect(parsearSituacionTributaria(respuestaOk({ girosNegocio: {} }), '22222222-2').actividades).toEqual([]);
  });

  // La propia API dice `registrado: false` cuando el RUT no existe — a
  // diferencia del CGI viejo, donde había que inferirlo de campos ausentes.
  it('registrado=false → RecursoNoEncontrado', () => {
    expect(() => parsearSituacionTributaria(respuestaOk({ registrado: false }), '11111111-1'))
      .toThrow(RecursoNoEncontrado);
  });

  // El bloqueante del review: sin exigir `registrado === true` explícito, una
  // página de mantención u otro JSON del SII (sin el campo, o con otra forma)
  // se colaba como consulta válida con todo en null.
  it('registrado ausente → Error genérico, NO una consulta válida vacía', () => {
    const { registrado, ...sinRegistrado } = respuestaOk();
    expect(() => parsearSituacionTributaria(sinRegistrado, '22222222-2'))
      .toThrow(/no devolvió el informe de situación tributaria esperado/);
    expect(() => parsearSituacionTributaria(sinRegistrado, '22222222-2'))
      .not.toThrow(RecursoNoEncontrado);
  });

  it('registrado con otra forma (no boolean) → Error genérico', () => {
    expect(() => parsearSituacionTributaria(respuestaOk({ registrado: 'si' }), '22222222-2'))
      .toThrow(/no devolvió el informe de situación tributaria esperado/);
  });

  it('una respuesta que no es un objeto → Error genérico, no NO_ENCONTRADO', () => {
    expect(() => parsearSituacionTributaria('<html>mantención</html>', '11111111-1'))
      .toThrow(/no devolvió un JSON reconocible/);
    expect(() => parsearSituacionTributaria('<html>mantención</html>', '11111111-1'))
      .not.toThrow(RecursoNoEncontrado);
  });

  it('nombre en blanco (contribuyente sin razón social) no se confunde con NO_ENCONTRADO', () => {
    // Visto en vivo: registrado=true con nombre="**" para un RUT sin nombre
    // asociado. Sólo `registrado: false` es NO_ENCONTRADO.
    const sit = parsearSituacionTributaria(respuestaOk({ nombre: '**' }), '22222222-2');
    expect(sit.razonSocial).toBe('**');
  });
});

describe('consultarSituacionTributaria', () => {
  function transporte(overrides: Partial<TransporteSituacion> = {}): TransporteSituacion {
    return {
      recaptchaHabilitado: async () => false,
      consultarDatos: async () => respuestaOk(),
      ...overrides,
    };
  }

  it('arma rut/dv normalizados y parsea la respuesta', async () => {
    let rutEnviado = ''; let dvEnviado = '';
    const t = transporte({
      consultarDatos: async (rut, dv) => { rutEnviado = rut; dvEnviado = dv; return respuestaOk(); },
    });
    const sit = await consultarSituacionTributaria('22.222.222-2', t);
    expect(rutEnviado).toBe('22222222');
    expect(dvEnviado).toBe('2');
    expect(sit.razonSocial).toBe('EMPRESA DE EJEMPLO SPA');
  });

  // El SII puede prender reCAPTCHA en cualquier momento (hoy, 01-09-2026, está
  // apagado). Sin esto, se mandaría un token vacío y el SII lo rechazaría con
  // un error genérico e indistinguible de un fallo real.
  it('reCAPTCHA activo → LimitacionConocida, no consulta datos', async () => {
    const consultarDatos = jest.fn();
    const t = transporte({ recaptchaHabilitado: async () => true, consultarDatos });
    await expect(consultarSituacionTributaria('22.222.222-2', t)).rejects.toThrow(LimitacionConocida);
    expect(consultarDatos).not.toHaveBeenCalled();
  });
});
