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

const HTML = fixture('situacion-tributaria-76632059.html');

describe('parsearSituacionTributaria', () => {
  const sit = parsearSituacionTributaria(HTML, '76632059-7');

  it('extrae identificación y razón social', () => {
    expect(sit.rut).toBe('76632059-7');
    expect(sit.razonSocial).toBe('INFOSEC SERVICIOS DE SEGURIDAD INFORMATICA SPA');
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

  it('RUT no reconocido → RecursoNoEncontrado', () => {
    expect(() => parsearSituacionTributaria('<html><body>sin datos</body></html>', '11111111-1'))
      .toThrow(RecursoNoEncontrado);
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
    const sit = await consultarSituacionTributaria('76.632.059-7', transporte);
    expect(sit.razonSocial).toBe('INFOSEC SERVICIOS DE SEGURIDAD INFORMATICA SPA');
    expect(camposEnviados).toEqual({
      RUT: '76632059', DV: '7', PRG: 'STC', OPC: 'NOR', txt_code: 'AB12', txt_captcha: captchaB64,
    });
  });
});
