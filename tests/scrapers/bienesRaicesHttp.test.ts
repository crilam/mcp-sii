import * as fs from 'fs';
import * as path from 'path';
import { BienesRaicesHttpScraper } from '../../src/scrapers/bienesRaicesHttp';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { RecursoNoEncontrado } from '../../src/erroresConsulta';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'utf-8');
}

const CABECERA = fixture('bienes-raices-cabecera.json');
const PROPIEDADES = fixture('bienes-raices-propiedades.json');
const COMUNAS = fixture('bienes-raices-comunas.json');
const SOLICITUDES = fixture('bienes-raices-solicitudes.json');
const MULTIPROPIETARIOS = fixture('bienes-raices-multipropietarios.json');

const HOST = 'https://www2.sii.cl';
const ENTRADA = `${HOST}/vica/Menu/BienesRaices`;
const STATUS = `${HOST}/app/session/status`;
const BASE = `${HOST}/app/vica/11111111-1/v1`;

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.identidad as jest.Mock) = jest.fn(() => ({ rut: '11111111', dv: '1' }));
  (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn(() => {});
  const scraper = new BienesRaicesHttpScraper(http, session);
  return { scraper, http, session };
}

describe('BienesRaicesHttpScraper handshake', () => {
  // Sin este orden exacto la API responde 0 bytes: el index y /app/session/status
  // dejan la cookie del contexto /app sin la cual el backend no contesta.
  it('la primera llamada hace el handshake completo antes de la ruta de datos', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('') // entrada vica
      .mockResolvedValueOnce('') // session status
      .mockResolvedValueOnce(CABECERA)
      .mockResolvedValueOnce(PROPIEDADES);

    await scraper.listBienesRaices();

    const llamadas = (http.get as jest.Mock).mock.calls;
    expect(llamadas[0][0]).toBe(ENTRADA);
    expect(llamadas[0][2]).toMatchObject({ guardarCookies: true });
    expect(llamadas[1][0]).toBe(STATUS);
    expect(llamadas[1][1]).toEqual({ originalUrl: ENTRADA });
    expect(llamadas[1][2]).toMatchObject({ guardarCookies: true });
  });

  // El handshake se guarda una vez por instancia: repetirlo en cada llamada
  // sería tráfico extra contra un portal que ya castiga a los scrapers.
  it('una segunda llamada al mismo scraper no repite el handshake', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(CABECERA)
      .mockResolvedValueOnce(PROPIEDADES)
      .mockResolvedValueOnce(CABECERA)
      .mockResolvedValueOnce(PROPIEDADES);

    await scraper.listBienesRaices();
    const llamadasTrasLaPrimera = (http.get as jest.Mock).mock.calls.length;
    await scraper.listBienesRaices();

    expect((http.get as jest.Mock).mock.calls.length).toBe(llamadasTrasLaPrimera + 2);
  });
});

describe('BienesRaicesHttpScraper base de la URL', () => {
  // Sin guion entre RUT y DV el backend no reconoce la ruta: es lo que arma la
  // SPA en `/app/vica/{rut-dv}/v1/...`.
  it('arma la base con el RUT y DV separados por guion', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce(CABECERA).mockResolvedValueOnce(PROPIEDADES);

    await scraper.listBienesRaices();

    const llamadas = (http.get as jest.Mock).mock.calls;
    expect(llamadas[2][0]).toBe(`${BASE}/mis-bbrr/obtener/cabecera`);
    expect(llamadas[3][0]).toBe(`${BASE}/mis-bbrr/get/by-rut`);
  });
});

describe('BienesRaicesHttpScraper.listBienesRaices', () => {
  function conListado(cabecera: string = CABECERA, propiedades: string = PROPIEDADES) {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce(cabecera).mockResolvedValueOnce(propiedades);
    return { scraper, http };
  }

  // La cabecera de la fixture trae totalBienesRaices: 0 pero la lista trae 3
  // propiedades reales: medido en vivo, la cabecera no es confiable para el total.
  it('el total sale de la lista y no de la cabecera', async () => {
    const { scraper } = conListado();

    const res = await scraper.listBienesRaices();

    expect(res.resumen.totalBienesRaices).toBe(3);
    expect(res.propiedades).toHaveLength(3);
  });

  // Fija el mapeo campo a campo contra los valores reales de la fixture: un
  // typo en el nombre del campo de origen no se nota si sólo se chequea el largo.
  it('mapea el primer elemento completo con los valores exactos de la fixture', async () => {
    const { scraper } = conListado();

    const res = await scraper.listBienesRaices();

    expect(res.propiedades[0]).toEqual({
      comuna: 'CONCEPCION',
      rol: '00632-00244',
      direccion: 'CALLE DE PRUEBA 123 DP 1604 P RODRIGUEZ II',
      destino: 'HABITACIONAL',
      fojas: '6603',
      numero: '5204',
      anio: '2019',
      porcentajeDerechos: 100,
      avaluoFiscal: 51230998,
      comunaCodigo: 8201,
      manzana: 632,
      predio: 244,
      ultimoEacAplicado: 14,
    });
  });

  // solicitudesResueltas viene de solicitudesCerradas (nombre distinto en el
  // origen); los flags booleanos deben quedar estrictamente true/false.
  it('arma el resumen con solicitudesResueltas = solicitudesCerradas y los flags booleanos', async () => {
    const { scraper } = conListado();

    const res = await scraper.listBienesRaices();

    expect(res.resumen.solicitudesResueltas).toBe(0);
    expect(res.resumen.afectoSobretasa).toBe(true);
    expect(res.resumen.beneficioAdultoMayor).toBe(false);
  });

  // Dos backends detrás del mismo gateway: uno envuelve al estilo Spring y el
  // otro devuelve el dato pelado. Ambas formas tienen que funcionar igual.
  it('acepta la respuesta envuelta estilo Spring y también la lista pelada', async () => {
    const envuelta = JSON.stringify({
      statusCodeValue: 200,
      body: JSON.parse(CABECERA),
      headers: {},
      statusCode: 'OK',
    });
    const { scraper } = conListado(envuelta, PROPIEDADES);

    const res = await scraper.listBienesRaices();

    expect(res.resumen.afectoSobretasa).toBe(true);
    expect(res.propiedades).toHaveLength(3);
  });
});

describe('BienesRaicesHttpScraper.comunas', () => {
  function conComunas() {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce(COMUNAS);
    return { scraper, http };
  }

  // El campo `codigo` viene en 0 en toda la lista: usarlo en vez de
  // `codigoConaraSii` rompería silenciosamente cualquier consulta por comuna.
  it('usa codigoConaraSii como codigo, no el campo codigo que viene en 0', async () => {
    const { scraper } = conComunas();

    const res = await scraper.comunas();

    expect(res).toHaveLength(5);
    expect(res[0]).toEqual({ codigo: 5406, nombre: 'ALGARROBO', regional: 5 });
  });
});

describe('BienesRaicesHttpScraper.multipropietarios', () => {
  function conMultipropietarios() {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce(MULTIPROPIETARIOS);
    return { scraper, http };
  }

  // La consulta viaja como querystring string, no numérica: el backend de esta
  // ruta espera texto en comuna/manzana/predio.
  it('manda comuna, manzana y predio como strings en la query', async () => {
    const { scraper, http } = conMultipropietarios();

    await scraper.multipropietarios({ comuna: 8201, manzana: 632, predio: 244 });

    const llamada = (http.get as jest.Mock).mock.calls[2];
    expect(llamada[0]).toBe(`${BASE}/multipropietarios/get/by-rol`);
    expect(llamada[1]).toEqual({ comuna: '8201', manzana: '632', predio: '244' });
  });

  // El RUT llega con espacios y puntos ("11.111.111-1"); sin normalizar no
  // calza con el formato que usa el resto del servicio.
  it('normaliza el RUT quitando espacios y puntos, y el porcentaje queda numérico', async () => {
    const { scraper } = conMultipropietarios();

    const res = await scraper.multipropietarios({ comuna: 8201, manzana: 632, predio: 244 });

    expect(res[0].rut).toBe('11111111-1');
    expect(res[0].porcentajeDerechos).toBe(100);
  });
});

describe('BienesRaicesHttpScraper.solicitudes', () => {
  function conSolicitudes() {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce(SOLICITUDES);
    return { scraper, http };
  }

  // La fixture trae "tipoSolicitud" con un espacio final; sin recortarlo, un
  // consumidor que compare el tipo por igualdad exacta nunca matchea.
  it('devuelve 2 elementos con el tipo sin espacios al final y conserva la url tal cual', async () => {
    const { scraper } = conSolicitudes();

    const res = await scraper.solicitudes();

    expect(res).toHaveLength(2);
    expect(res[0].tipo).toBe('Documento de Antecedentes del bien raÃ­z y detalle catastral');
    expect(res[0].tipo.endsWith(' ')).toBe(false);
    expect(res[0].url).toBe('/descarga/documento/a9474a73-89c2-4498-ae91-f73ae483233b/V5642722');
  });
});

describe('BienesRaicesHttpScraper.consultarPorRol', () => {
  function conRespuesta(cuerpo: string) {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValueOnce('').mockResolvedValueOnce('');
    (http.postJson as jest.Mock).mockResolvedValueOnce(cuerpo);
    return { scraper, http };
  }

  // Distingue el body numérico que espera esta ruta (comunaCnp/manzanaCnp/predioCnp)
  // del contrato público RolPredio, que usa otros nombres de campo.
  it('hace POST a by-rol-sc con el body numérico esperado', async () => {
    const { scraper, http } = conRespuesta('[]');

    await scraper.consultarPorRol({ comuna: 8201, manzana: 632, predio: 244 });

    expect(http.postJson).toHaveBeenCalledWith(
      `${BASE}/mis-bbrr/obtener/by-rol-sc`,
      { comunaCnp: 8201, manzanaCnp: 632, predioCnp: 244 },
      expect.objectContaining({ guardarCookies: true }));
  });

  // La API contesta 204/cuerpo vacío tanto cuando el rol no existe como cuando
  // no hay datos: acá se traduce a RecursoNoEncontrado, no a lista vacía.
  it('un cuerpo vacío lanza RecursoNoEncontrado', async () => {
    const { scraper } = conRespuesta('');

    await expect(scraper.consultarPorRol({ comuna: 8201, manzana: 632, predio: 244 }))
      .rejects.toThrow(RecursoNoEncontrado);
  });

  // Fija el mapeo de la forma "sin clave", que usa nombres distintos a los del
  // listado autenticado (avaluoFiscalS/totalContribS en vez de avaluoFiscal).
  it('una lista devuelta se mapea a comuna/rol/direccion/destino/avaluoFiscal/contribuciones', async () => {
    const cruda = JSON.stringify([{
      comuna: 'CONCEPCION', rol: '00632-00244', direccion: 'CALLE DE PRUEBA 123',
      destino: 'HABITACIONAL', avaluoFiscalS: '51.230.998', totalContribS: '0',
    }]);
    const { scraper } = conRespuesta(cruda);

    const res = await scraper.consultarPorRol({ comuna: 8201, manzana: 632, predio: 244 });

    expect(res).toEqual([{
      comuna: 'CONCEPCION', rol: '00632-00244', direccion: 'CALLE DE PRUEBA 123',
      destino: 'HABITACIONAL', avaluoFiscal: '51.230.998', contribuciones: '0',
    }]);
  });
});

describe('BienesRaicesHttpScraper.certificadoAvaluo', () => {
  const PDF_B64 = Buffer.from('%PDF-1.4 x').toString('base64');
  const bien = { comuna: 8201, manzana: 632, predio: 244, ultimoEacAplicado: 14 };

  function conRespuesta(cuerpo: string) {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValueOnce('').mockResolvedValueOnce('');
    (http.postJson as jest.Mock).mockResolvedValueOnce(cuerpo);
    return { scraper, http };
  }

  // El body exacto es el `parametroscertificados` que arma la SPA: un campo de
  // más o de menos y el SII rechaza la solicitud sin decir cuál faltó.
  it('simple: POST a post/simple con el body exacto', async () => {
    const { scraper, http } = conRespuesta(PDF_B64);

    await scraper.certificadoAvaluo([bien], 'simple');

    expect(http.postJson).toHaveBeenCalledWith(
      `${BASE}/cert-avaluo-fiscal/post/simple`,
      {
        tipoDocumento: '1',
        tipoSolicitante: '1',
        // "0" es el centinela de "no aplica" de la SPA; con "" el backend
        // responde "Error en los parametros enviados". Medido.
        motivo: '0',
        institucionReceptor: '0',
        // 1 = "ver": es el flujo que devuelve el PDF en el cuerpo.
        tipoSolicitud: 1,
        incluirMultiProp: '',
        bienesRaices: [{ comunaCnp: 8201, manzanaCnp: 632, predioCnp: 244, ultimoEacAplicado: 14 }],
      },
      expect.objectContaining({ guardarCookies: true }));
  });

  // El tipo 'detallado' usa otra ruta y otro código de documento: mezclarlos
  // haría que el SII devolviera el certificado equivocado.
  it('detallado: POST a post/detallado con tipoDocumento 3', async () => {
    const { scraper, http } = conRespuesta(PDF_B64);

    await scraper.certificadoAvaluo([bien], 'detallado');

    expect(http.postJson).toHaveBeenCalledWith(
      `${BASE}/cert-avaluo-fiscal/post/detallado`,
      expect.objectContaining({ tipoDocumento: '3' }),
      expect.any(Object));
  });

  // El multipropietario se distingue por la RUTA y el tipoDocumento; la SPA manda
  // incluirMultiProp como "" en este flujo, no como boolean. Si no el SII sólo
  // certifica el porcentaje del solicitante y no de todos los copropietarios.
  it('multipropietario: post/multipropietario con tipoDocumento 2', async () => {
    const { scraper, http } = conRespuesta(PDF_B64);

    await scraper.certificadoAvaluo([bien], 'multipropietario');

    expect(http.postJson).toHaveBeenCalledWith(
      `${BASE}/cert-avaluo-fiscal/post/multipropietario`,
      expect.objectContaining({ tipoDocumento: '2', incluirMultiProp: '' }),
      expect.any(Object));
  });

  it('devuelve el Buffer del PDF decodificado desde el base64', async () => {
    const { scraper } = conRespuesta(PDF_B64);

    const pdf = await scraper.certificadoAvaluo([bien], 'simple');

    expect(pdf).toEqual(Buffer.from('%PDF-1.4 x'));
  });

  // La SPA hace window.atob a secas: un error del backend también llega como
  // texto, y decodificarlo como si fuera PDF entrega bytes que nadie abre.
  it('si el base64 no empieza con %PDF- lanza error explícito', async () => {
    const noPdf = Buffer.from('ERROR INTERNO').toString('base64');
    const { scraper } = conRespuesta(noPdf);

    await expect(scraper.certificadoAvaluo([bien], 'simple')).rejects.toThrow(/no devolvió un PDF/);
  });

  it('con lista vacía de bienes lanza error antes de llamar a la red', async () => {
    const { scraper } = armar();

    await expect(scraper.certificadoAvaluo([], 'simple')).rejects.toThrow(/al menos un bien raíz/);
  });
});

describe('BienesRaicesHttpScraper.descargarDocumento', () => {
  const URL_VALIDA = '/descarga/documento/a9474a73-89c2-4498-ae91-f73ae483233b/V5642722';

  function conBinario(contenido: Buffer, contentType = 'application/pdf') {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValueOnce('').mockResolvedValueOnce('');
    (http.getBinario as jest.Mock) = jest.fn().mockResolvedValue({ contenido, contentType });
    return { scraper, http };
  }

  // Sólo la forma que devuelve la lista de solicitudes es válida: aceptar
  // cualquier string abriría la puerta a construir rutas arbitrarias.
  it.each(['https://x/y', '../../etc'])('rechaza una url que no tiene la forma esperada (%s)', async (url) => {
    const { scraper } = armar();

    await expect(scraper.descargarDocumento(url)).rejects.toThrow(/url del documento/);
  });

  it('con contentType pdf devuelve el Buffer tal cual', async () => {
    const pdf = Buffer.from('%PDF-1.4 contenido');
    const { scraper, http } = conBinario(pdf);

    const res = await scraper.descargarDocumento(URL_VALIDA);

    expect(res).toEqual(pdf);
    expect(http.getBinario).toHaveBeenCalledWith(`${BASE}${URL_VALIDA}`);
  });
});

describe('BienesRaicesHttpScraper errores de la API', () => {
  // Cuerpo vacío es el modo de falla característico de esta API cuando falta
  // contexto de sesión: nombrarlo evita perseguir un bug de parseo inexistente.
  it('una respuesta vacía en una ruta de datos lanza error de "respondió vacío"', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    await expect(scraper.comunas()).rejects.toThrow(/respondió vacío/);
  });

  // El servidor de aplicaciones puede responder HTML de error (login, 500);
  // sin este chequeo el fallo se vería como un JSON.parse roto sin contexto.
  it('una respuesta HTML lanza error de "no devolvió JSON"', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockResolvedValueOnce('<html>Error</html>');

    await expect(scraper.comunas()).rejects.toThrow(/no devolvió JSON/);
  });
});
