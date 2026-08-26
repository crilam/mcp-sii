import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  extraerRutsSospechosos,
  extraerCorreosSospechosos,
  extraerIpsSospechosas,
  extraerDatosPersonales,
  esRutaExcluida,
} from './anonimizacion';

// Las respuestas del SII traen RUT, nombres y montos reales. El repositorio es
// público, así que un RUT real filtrado es una filtración — y no sólo en las
// fixtures: antes este chequeo miraba únicamente tests/fixtures/*.html y por eso
// no atrapó RUT reales que quedaron en código y documentación. Ahora se enumera
// con `git ls-files`, o sea exactamente lo que se publica.
const RAIZ = path.join(__dirname, '..');

// Archivos generados o binarios: no contienen datos capturados del portal y
// sólo aportan falsos positivos.
const EXTENSIONES_IGNORADAS = ['.png', '.jpg', '.gif', '.pdf', '.ico'];
const GENERADOS = ['package-lock.json'];

function archivosVersionados(): string[] {
  const salida = execFileSync('git', ['ls-files', '-z'], {
    cwd: RAIZ,
    encoding: 'utf-8',
  });
  return salida
    .split('\0')
    .filter(Boolean)
    .filter(f => !esRutaExcluida(f))
    .filter(f => !GENERADOS.includes(f))
    .filter(f => !EXTENSIONES_IGNORADAS.includes(path.extname(f).toLowerCase()));
}

describe('anonimización de los archivos versionados', () => {
  const archivos = archivosVersionados();

  it('hay archivos que revisar', () => {
    expect(archivos.length).toBeGreaterThan(0);
  });

  // Las respuestas del SII vienen en ISO-8859-1; latin1 lee cualquier byte sin
  // fallar, así que sirve para todo el árbol.
  it.each(archivos)('%s no contiene datos personales', (relativa) => {
    const contenido = fs.readFileSync(path.join(RAIZ, relativa), 'latin1');

    expect(extraerDatosPersonales(contenido)).toEqual([]);
  });
});

// Sin estos tests el chequeo podría dejar de detectar y nadie lo notaría. Usan
// la MISMA función que el chequeo: cuando el regex estaba duplicado, una
// divergencia dejaba estos tests en verde probando algo que ya no corría.
describe('extraerRutsSospechosos', () => {
  it('detecta un RUT real en un campo de xml_values', () => {
    const contenido = `xml_values['rut_arrastre'] = "12345678";`;

    expect(extraerRutsSospechosos(contenido)).toContain('12345678');
  });

  // El informe mensual guarda el RUT de la contraparte en arr_informe_mensual,
  // no en xml_values: ese hueco ya pasó inadvertido una vez.
  it('detecta un RUT real dentro de un arreglo distinto de xml_values', () => {
    const contenido = `arr_informe_mensual['rutemisor_1'] = "87654321";`;

    expect(extraerRutsSospechosos(contenido)).toContain('87654321');
  });

  // El hallazgo que motivó ampliar el chequeo: un RUT con guión escrito en un
  // .ts o un .md, fuera de toda fixture.
  it('detecta un RUT con dígito verificador en código o documentación', () => {
    const contenido = 'const rut = "98765432-1"; // ejemplo de la doc';

    expect(extraerRutsSospechosos(contenido)).toContain('98765432-1');
  });

  it('acepta los RUT ficticios de dígito repetido', () => {
    const contenido = `
      xml_values['rut_arrastre'] = "11111111";
      arr_informe_mensual['rutreceptor_1'] = "22222222";
      arr_informe_mensual['rutemisor_1'] = "33333333";
      const ejemplo = "11111111-1";
    `;

    expect(extraerRutsSospechosos(contenido)).toEqual([]);
  });

  // Montos, folios y códigos de barra son números largos que NO son RUT: un
  // chequeo que los marcara sería ruido y terminaría desactivado.
  it('no marca montos ni folios como RUT', () => {
    const contenido = `
      xml_values['ene1'] = "3884935";
      arr_informe_mensual['codigobarras_1'] = "111111110000048F99ED";
      arr_informe_mensual['totalhonorarios_1'] = formatMiles("1000000",'.');
    `;

    expect(extraerRutsSospechosos(contenido)).toEqual([]);
  });
});

// La fixture de renta que motivó ampliar el chequeo traía correo del
// contribuyente e IP de presentación: ninguno es un RUT, y por eso pasó.
describe('extraerCorreosSospechosos', () => {
  it('detecta un correo de dominio real', () => {
    const contenido = `xml_values['email'] = "juan.perez@gmail.com";`;

    expect(extraerCorreosSospechosos(contenido)).toContain('juan.perez@gmail.com');
  });

  it('acepta los dominios de ejemplo que usan las fixtures', () => {
    const contenido = `
      contribuyente@ejemplo.cl
      receptor@ejemplo.cl
      alguien@example.com
      qa@test.cl
    `;

    expect(extraerCorreosSospechosos(contenido)).toEqual([]);
  });
});

describe('extraerIpsSospechosas', () => {
  it('detecta una IP pública', () => {
    const contenido = `xml_values['ip_presentacion'] = "8.8.4.4";`;

    expect(extraerIpsSospechosas(contenido)).toContain('8.8.4.4');
  });

  it('acepta IP privadas y de documentación', () => {
    const contenido = `
      192.168.1.10
      10.0.0.5
      172.16.3.4
      127.0.0.1
      203.0.113.10
      198.51.100.7
      192.0.2.44
    `;

    expect(extraerIpsSospechosas(contenido)).toEqual([]);
  });

  // El código de error de sesiones del SII y los números de versión aparecen
  // por todo el repositorio: si los marcara, el chequeo terminaría apagado.
  it('no marca códigos de error ni versiones como IP', () => {
    const contenido = `
      Error 01.01.190.500.720.27 del SII
      "@types/node": "^25.8.0"
    `;

    expect(extraerIpsSospechosas(contenido)).toEqual([]);
  });

  // El User-Agent del scraper de indicadores trae `Chrome/126.0.0.0`, que tiene
  // cuatro octetos en rango y no es la dirección de nadie.
  it('no marca la versión del User-Agent como IP', () => {
    const contenido = 'Chrome/126.0.0.0 Safari/537.36';

    expect(extraerIpsSospechosas(contenido)).toEqual([]);
  });

  // La excepción es sólo para el cuádruple pegado a `nombre/`: una IP dentro de
  // una URL sigue siendo una IP, y ahí es donde aparecería una real.
  it('sigue marcando una IP pública dentro de una URL', () => {
    expect(extraerIpsSospechosas('https://8.8.4.4/consulta')).toContain('8.8.4.4');
  });
});

describe('extraerDatosPersonales', () => {
  it('agrega los hallazgos de todos los detectores', () => {
    const contenido = `
      const rut = "98765432-1";
      const correo = "juan.perez@gmail.com";
      const ip = "8.8.4.4";
    `;

    expect(extraerDatosPersonales(contenido)).toEqual(
      expect.arrayContaining(['98765432-1', 'juan.perez@gmail.com', '8.8.4.4'])
    );
  });
});
