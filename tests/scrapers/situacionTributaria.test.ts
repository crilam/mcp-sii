import * as fs from 'fs';
import * as path from 'path';
import {
  parsearSituacionTributaria,
  codigoCaptcha,
  consultarSituacionTributaria,
  TransporteSituacion,
} from '../../src/scrapers/situacionTributaria';
import { RecursoNoEncontrado } from '../../src/erroresConsulta';

// El getstc del SII responde ISO-8859-1: el fixture se lee como latin1, igual
// que hace el transporte real al decodificar la respuesta.
function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '../fixtures', nombre), 'latin1');
}

const HTML = fixture('situacion-tributaria.html');

describe('parsearSituacionTributaria', () => {
  const sit = parsearSituacionTributaria(HTML, '22222222-2');

  it('extrae identificación y razón social', () => {
    expect(sit.rut).toBe('22222222-2');
    expect(sit.razonSocial).toBe('EMPRESA DE EJEMPLO SPA');
  });

  it('extrae inicio de actividades, fecha, pro-pyme y moneda', () => {
    expect(sit.inicioActividades).toBe(true);
    expect(sit.fechaInicioActividades).toBe('08-07-2016');
    expect(sit.proPyme).toBe(true);
    expect(sit.monedaExtranjera).toBe(false);
  });

  it('extrae las actividades económicas (y sólo esas, no las filas de otras tablas)', () => {
    expect(sit.actividades).toEqual([
      { giro: 'FABRICACION DE COMPUTADORES Y EQUIPO PERIFERICO', codigo: 262000, categoria: 1, afectaIva: true },
      { giro: 'ACTIVIDADES DE CONSULTORIA DE INFORMATICA Y DE GESTION DE INSTALACIONE', codigo: 620200, categoria: 1, afectaIva: true },
      { giro: 'PROCESAMIENTO DE DATOS, HOSPEDAJE Y ACTIVIDADES CONEXAS', codigo: 631100, categoria: 1, afectaIva: true },
    ]);
  });

  it('no deja entrar las fechas de la tabla de autorización no electrónica', () => {
    // "01-02-2017" es una celda de otra tabla class="tabla"; jamás debe aparecer
    // como código/giro de una actividad.
    expect(sit.actividades.some(a => a.giro?.includes('2017'))).toBe(false);
    expect(sit.actividades).toHaveLength(3);
  });

  // El HTML lleva el título del informe: un RUT que el SII no reconoce SÍ
  // devuelve esta página, sólo que sin los campos del contribuyente.
  it('RUT no reconocido → RecursoNoEncontrado', () => {
    const sinDatos = '<html><title>Consultar Situaci&oacute;n Tributaria de Terceros</title><body>' +
      'El RUT consultado no presenta informaci&oacute;n</body></html>';
    expect(() => parsearSituacionTributaria(sinDatos, '11111111-1'))
      .toThrow(RecursoNoEncontrado);
  });

  // Éste es el que importa: sin la marca del informe, una página de mantención o
  // un rediseño del CGI se reportaban como NO_ENCONTRADO, o sea el SII caído era
  // indistinguible de "este RUT no existe". El consumidor archivaba un "no
  // existe" permanente sobre un fallo transitorio y nadie volvía a mirarlo.
  it('respuesta que no es el informe → Error genérico, no NO_ENCONTRADO', () => {
    const mantencion = '<html><body>Servicio temporalmente no disponible</body></html>';
    expect(() => parsearSituacionTributaria(mantencion, '11111111-1'))
      .toThrow(/no devolvió la página de situación tributaria/);
    expect(() => parsearSituacionTributaria(mantencion, '11111111-1'))
      .not.toThrow(RecursoNoEncontrado);
  });

  // Con el DV equivocado el SII resuelve por el cuerpo y devuelve los datos con
  // SU dígito: comparar sólo el cuerpo dejaba pasar un RUT inexistente como
  // válido. Se compara cuerpo Y dígito.
  it('mismo cuerpo con DV distinto → RecursoNoEncontrado', () => {
    expect(() => parsearSituacionTributaria(HTML, '22222222-9')).toThrow(RecursoNoEncontrado);
  });

  it('RUT reportado distinto del pedido → RecursoNoEncontrado (no atribuir datos ajenos)', () => {
    expect(() => parsearSituacionTributaria(HTML, '11111111-1')).toThrow(RecursoNoEncontrado);
  });
});

describe('codigoCaptcha', () => {
  it('extrae los 4 caracteres del blob (bytes 36..40)', () => {
    const bytes = Buffer.concat([Buffer.alloc(36, 0), Buffer.from('3331', 'latin1'), Buffer.alloc(4, 0)]);
    expect(codigoCaptcha(bytes.toString('base64'))).toBe('3331');
  });
});

describe('consultarSituacionTributaria', () => {
  it('arma los campos del getstc y parsea la respuesta', async () => {
    const bytes = Buffer.concat([Buffer.alloc(36, 0), Buffer.from('AB12', 'latin1'), Buffer.alloc(4, 0)]);
    const captchaB64 = bytes.toString('base64');
    let camposEnviados: Record<string, string> = {};
    const transporte: TransporteSituacion = {
      obtenerCaptcha: async () => captchaB64,
      consultarGetstc: async campos => { camposEnviados = campos; return HTML; },
    };
    const sit = await consultarSituacionTributaria('22.222.222-2', transporte);
    expect(sit.razonSocial).toBe('EMPRESA DE EJEMPLO SPA');
    expect(camposEnviados).toEqual({
      RUT: '22222222', DV: '2', PRG: 'STC', OPC: 'NOR', txt_code: 'AB12', txt_captcha: captchaB64,
    });
  });
});
