import * as fs from 'fs';
import * as path from 'path';
import { BheScraper } from '../../src/scrapers/bhe';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { LimitacionConocida, LimiteDeConsultasSii } from '../../src/erroresConsulta';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '../fixtures', nombre), 'latin1');
}

function makeScraper(html: string) {
  const http = new MockHttp({} as any);
  const session = new MockSession({} as any, {} as any);
  // Se mockean ambos verbos: el informe anual usa GET y el mensual POST.
  (http.get as jest.Mock).mockResolvedValue(html);
  (http.postForm as jest.Mock).mockResolvedValue(html);
  (session.authenticateOnly as jest.Mock).mockResolvedValue(undefined);
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { http, session, scraper: new BheScraper(http, session) };
}

describe('BheScraper.informeAnual', () => {
  it('parsea la cabecera del informe', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.anio).toBe(2025);
    expect(informe.rut).toBe('11111111-1');
    expect(informe.nombreContribuyente).toBe('JUAN PEREZ SOTO');
  });

  // El informe cubre el año calendario completo, así que se devuelven los doce
  // meses siempre: un mes sin actividad son ceros, no una fila ausente. Así el
  // consumidor indexa por mes sin tener que reconstruir los huecos.
  it('devuelve los doce meses, con ceros en los que no tuvieron actividad', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses).toHaveLength(12);
    expect(informe.meses.map(m => m.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(informe.meses[2]).toEqual({
      mes: 3,
      honorarioBruto: 0,
      retencionTerceros: 0,
      retencionContribuyente: 0,
      totalLiquido: 0,
      folioInicial: null,
      folioFinal: null,
      emisionesVigentes: 0,
      emisionesAnuladas: 0,
    });
    expect(informe.meses[0]).toEqual({
      mes: 1,
      honorarioBruto: 1000000,
      retencionTerceros: 145000,
      retencionContribuyente: 0,
      // El CGI no manda el líquido: lo calcula su propio JS como
      // bruto - retTerceros - retContribuyente. 1000000 - 145000 - 0.
      totalLiquido: 855000,
      folioInicial: 101,
      folioFinal: 102,
      emisionesVigentes: 2,
      emisionesAnuladas: 1,
    });
  });

  // Una columna ausente significa cero emisiones anuladas, no un dato perdido.
  it('trata las columnas vacías como cero', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses[1].emisionesAnuladas).toBe(0);
  });

  // Omitir el mes haria que el consumidor lo lea como "no emitio", y un motor
  // contable que escribe "importado, sin emisiones" sobre un mes que si tuvo es
  // peor que un error: nadie vuelve a mirarlo.
  it('falla si un mes trae montos pero ningun folio legible', async () => {
    const { scraper } = makeScraper(`<html><body><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['ene1']= "1.500.000";
 xml_values['ene4']= "N/A";
 xml_values['tot4']= "101";
 xml_values['tot5']= "105";
</script></body></html>`);

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/datos para el mes 1/);
  });

  // El mismo parser sirve a los dos CGI. En recibidas las boletas las emitieron
  // terceros, así que un error que hable de "emisiones" manda a buscar el
  // problema al lado equivocado del informe.
  it('el error de un mes ilegible nombra el origen correcto', async () => {
    const html = `<html><body><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['ene1']= "1.500.000";
 xml_values['ene4']= "N/A";
 xml_values['tot4']= "101";
 xml_values['tot5']= "105";
</script></body></html>`;

    await expect(makeScraper(html).scraper.informeAnual(2025, true))
      .rejects.toThrow(/anual de recibidas[\s\S]*hubo boletas recibidas/);
    await expect(makeScraper(html).scraper.informeAnual(2025, false))
      .rejects.toThrow(/anual de emitidas[\s\S]*hubo emisiones/);
  });

  // La deteccion no depende del honorario bruto: un mes de puras boletas
  // anuladas tiene montos en cero y aun asi tuvo emisiones.
  it('falla tambien si el unico dato del mes son emisiones anuladas', async () => {
    const { scraper } = makeScraper(`<html><body><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['ene7']= "3";
 xml_values['ene4']= "";
 xml_values['tot4']= "101";
 xml_values['tot5']= "105";
</script></body></html>`);

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/datos para el mes 1/);
  });

  // Y un mes REALMENTE vacio se sigue omitiendo: asi informa el SII los meses
  // sin actividad, y convertirlos en error rompria todos los años incompletos.
  it('emite ceros para un mes sin folio y sin montos', async () => {
    const { scraper } = makeScraper(`<html><body><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['ene1']= "";
 xml_values['ene4']= "";
 xml_values['tot4']= "0";
 xml_values['tot5']= "0";
</script></body></html>`);

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses).toHaveLength(12);
    expect(informe.meses.every(m => m.honorarioBruto === 0 && m.folioInicial === null)).toBe(true);
  });

  // La formula es la del propio JS del informe:
  //   xml_values['sumene'] = Number(ene1) - Number(ene2) - Number(ene3)
  // Verificada contra la columna "(*)TOTAL LIQUIDO" del portal para los 8 meses
  // con actividad de 2026, incluido el total del año (42.735.336).
  it('calcula el total liquido como bruto menos las dos retenciones', async () => {
    const { scraper } = makeScraper(`<html><body><script>
 xml_values['anio_consulta'] = "2026";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['ene1']= "4391291";
 xml_values['ene2']= "669672";
 xml_values['ene3']= "0";
 xml_values['ene4']= "324";
 xml_values['ene5']= "324";
 xml_values['ene6']= "1";
 xml_values['tot4']= "324";
 xml_values['tot5']= "324";
</script></body></html>`);

    const informe = await scraper.informeAnual(2026);

    expect(informe.meses[0].totalLiquido).toBe(3721619);
  });

  it('expone el rango de folios del año', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.folioInicial).toBe(101);
    expect(informe.folioFinal).toBe(103);
  });

  // Un año sin boletas es una respuesta legítima, no un fallo.
  it('devuelve los doce meses en cero cuando el año no tiene boletas', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual-vacio.html'));

    const informe = await scraper.informeAnual(2019);

    expect(informe.meses).toHaveLength(12);
    expect(informe.meses.every(m => m.emisionesVigentes === 0)).toBe(true);
    // La respuesta real de un año sin boletas trae tot4/tot5 en "0", no
    // ausentes: el informe existe, sólo que sin folios emitidos.
    expect(informe.folioInicial).toBe(0);
  });

  // Sin esto, una sesión caída o una página de error se parsean como "el año
  // no tuvo boletas", que es indistinguible de un año realmente vacío.
  it('falla si la respuesta no es un informe de BHE', async () => {
    const { scraper } = makeScraper('<html><body>Sesión expirada</body></html>');

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/no devolvió un informe/);
  });

  it('consulta el CGI anual con el año pedido', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-anual.html'));

    await scraper.informeAnual(2025);

    const [url, params] = (http.get as jest.Mock).mock.calls[0];
    expect(url).toContain('TMBCOC_InformeAnualBhe.cgi');
    expect(params.cbanoinformeanual).toBe('2025');
    expect(params.rut_arrastre).toBe('11111111');
    expect(params.dv_arrastre).toBe('1');
  });

  // El anual de emitidas y el de recibidas son CGI distintos con el MISMO
  // esquema de claves, así que el único riesgo real es pedirle al equivocado.
  it('consulta el CGI anual de recibidas cuando se piden recibidas', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-anual.html'));

    await scraper.informeAnual(2025, true);

    const [url] = (http.get as jest.Mock).mock.calls[0];
    expect(url).toContain('TMBCOC_InformeAnualBheRec.cgi');
  });

  // Contra una respuesta real del CGI de recibidas, no sólo contra la URL: el
  // informe anual de recibidas trae una retención del contribuyente que el
  // informe MENSUAL de recibidas no muestra, así que este parseo es la única
  // fuente de ese dato y no se puede verificar sumando list-recibidas.
  // Contrastado campo por campo con la UI del portal para 2026.
  it('parsea el informe anual de recibidas', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual-recibidas.html'));

    const informe = await scraper.informeAnual(2026, true);

    expect(informe.meses[6]).toEqual({
      mes: 7,
      honorarioBruto: 134200,
      retencionTerceros: 0,
      retencionContribuyente: 19063,
      totalLiquido: 115137,
      // Nulos aunque el CGI mande 4435 y 15964516 en las columnas 4 y 5: el
      // portal no dibuja esas columnas en el informe de recibidas, y lo que
      // traen es el número de boleta más chico y el más grande del mes, de
      // emisores DISTINTOS. Publicarlo como rango de folios sugeriría una
      // continuidad que no existe.
      folioInicial: null,
      folioFinal: null,
      emisionesVigentes: 4,
      emisionesAnuladas: 0,
    });
    const suma = (f: (m: typeof informe.meses[0]) => number) =>
      informe.meses.reduce((a, m) => a + f(m), 0);
    expect(suma(m => m.honorarioBruto)).toBe(802700);
    expect(suma(m => m.retencionContribuyente)).toBe(118952);
    expect(suma(m => m.totalLiquido)).toBe(683748);
    expect(suma(m => m.emisionesVigentes)).toBe(18);
    // Tampoco a nivel de año: tot4/tot5 vienen con datos y se descartan igual.
    expect(informe.folioInicial).toBeNull();
    expect(informe.folioFinal).toBeNull();
  });

  // El mismo fixture leído como emitidas SÍ expone los folios: lo que cambia es
  // la semántica del informe, no el parseo.
  it('los folios sí salen cuando el informe es de emitidas', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual-recibidas.html'));

    const informe = await scraper.informeAnual(2026, false);

    // Los cuatro campos, no dos: es el test que demuestra que lo que cambia
    // entre los dos informes es la semántica y no el parseo, así que dejar la
    // mitad sin verificar deja abierta justo la duda que viene a cerrar.
    expect(informe.meses[6].folioInicial).toBe(4435);
    expect(informe.meses[6].folioFinal).toBe(15964516);
    expect(informe.folioInicial).toBe(4135);
    expect(informe.folioFinal).toBe(15992909);
  });

  // El CGI asigna las claves de montos dos veces: primero vacías y después con
  // los valores reales. Quedarse con la primera asignación devolvería el año
  // entero en cero pero con los folios correctos — un año que parece leído y
  // está vacío, que es justo el modo de falla silencioso que este archivo evita.
  it('se queda con la última asignación cuando el CGI reescribe una clave', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual-recibidas.html'));

    const informe = await scraper.informeAnual(2026, true);

    expect(informe.meses[2].retencionContribuyente).toBe(16013);
  });

  it('consulta el CGI de emitidas por defecto', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-anual.html'));

    await scraper.informeAnual(2025);

    const [url] = (http.get as jest.Mock).mock.calls[0];
    expect(url).not.toContain('Rec.cgi');
  });

  it('autentica sin exigir selección de empresa', async () => {
    const { scraper, session } = makeScraper(fixture('bhe-informe-anual.html'));

    await scraper.informeAnual(2025);

    expect(session.authenticateOnly).toHaveBeenCalled();
    expect(session.getSession).not.toHaveBeenCalled();
  });

  // No hay evidencia de que el SII emita montos negativos en este informe,
  // pero si alguna vez ocurre (ej. una corrección), truncar el signo
  // corrompería el dato en silencio. Se arma el HTML a mano porque las
  // fixtures no deben tocarse y no representan este caso.
  it('preserva el signo negativo de un monto', async () => {
    const html = `<html><body><script>
 xml_values['nombre_contribuyente'] = "JUAN PEREZ SOTO ";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['anio_consulta'] = "2025";
 xml_values['ene1']= "-15000";
 xml_values['ene2']= "0";
 xml_values['ene3']= "0";
 xml_values['ene4']= "101";
 xml_values['ene5']= "101";
 xml_values['ene6']= "1";
 xml_values['ene7']= "";
 xml_values['tot4']= "101";
 xml_values['tot5']= "101";
</script></body></html>`;
    const { scraper } = makeScraper(html);

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses[0].honorarioBruto).toBe(-15000);
  });

  // El punto SÍ debe seguir descartándose: el SII lo usa como separador de
  // miles en varios módulos (ver src/scrapers/bienesRaices.ts, que depende de
  // este mismo comportamiento para el avalúo fiscal).
  it('sigue quitando el separador de miles de un monto positivo', async () => {
    const html = `<html><body><script>
 xml_values['nombre_contribuyente'] = "JUAN PEREZ SOTO ";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['anio_consulta'] = "2025";
 xml_values['ene1']= "3.884.935";
 xml_values['ene2']= "0";
 xml_values['ene3']= "0";
 xml_values['ene4']= "101";
 xml_values['ene5']= "101";
 xml_values['ene6']= "1";
 xml_values['ene7']= "";
 xml_values['tot4']= "101";
 xml_values['tot5']= "101";
</script></body></html>`;
    const { scraper } = makeScraper(html);

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses[0].honorarioBruto).toBe(3884935);
  });
});

describe('BheScraper.informeMensual', () => {
  it('parsea las boletas del mes', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-mensual.html'));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas).toHaveLength(2);
    expect(boletas[0]).toEqual({
      folio: 311,
      // Es lo único que el SII acepta para pedir el PDF de esta boleta.
      codigoBarras: '111111110000048F99ED',
      fecha: '22/05/2025',
      // El CGI de emitidas los trae y antes se descartaban.
      fechaEmision: '22/05/2025',
      emailEnvio: 'receptor@ejemplo.cl',
      sociedadProfesional: false,
      usuarioEmisor: 'JUAN PEREZ SOTO ANDRADE',
      contraparteRol: 'receptor',
      contraparteRut: '22222222-2',
      contraparteNombre: 'EMPRESA EJEMPLO SPA',
      honorarioBruto: 1000000,
      retencionEmisor: 0,
      retencionReceptor: 145000,
      totalLiquido: 855000,
      anulada: false,
    });
  });

  // Los montos vienen envueltos en formatMiles("1000000",'.'), no como string
  // pelado: un parser que no lo contemple devuelve la expresion o nada.
  // Si el CGI renombra la variable, devolver 0 filas haria que el mes salga
  // vacio y el error apareciera despues como un descuadre de conteo, culpando a
  // la paginacion en vez de al parser.
  it('falla explicito si el informe no declara CantidadFilas', async () => {
    const { scraper } = makeScraper(
      `<html><script>xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
 arr_informe_mensual['nroboleta_1'] = "311";
</script></html>`
    );

    await expect(scraper.informeMensual(2025, 5)).rejects.toThrow(/no declara CantidadFilas/);
  });

  // En las capturas `fecha_boleta` y `fechaemision` coinciden, asi que un alias
  // entre las dos era invisible. Este test las separa a proposito: `fecha` es la
  // del documento y `fechaEmision` la de emision.
  it('distingue la fecha del documento de la de emision', async () => {
    const { scraper } = makeScraper(
      `<html><script>xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
CantidadFilas=1;
 arr_informe_mensual['nroboleta_1'] = "311";
 arr_informe_mensual['fecha_boleta_1'] = "20/05/2025";
 arr_informe_mensual['fechaemision_1'] = "22/05/2025";
</script></html>`
    );

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas[0].fecha).toBe('20/05/2025');
    expect(boletas[0].fechaEmision).toBe('22/05/2025');
  });

  it('marca sociedadProfesional cuando el CGI manda SI', async () => {
    const { scraper } = makeScraper(
      `<html><script>xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
CantidadFilas=1;
 arr_informe_mensual['nroboleta_1'] = "311";
 arr_informe_mensual['es_soc_profesional_1'] = "SI";
</script></html>`
    );

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas[0].sociedadProfesional).toBe(true);
  });

  it('desenvuelve los montos de formatMiles', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-mensual.html'));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas[1].honorarioBruto).toBe(2000000);
    expect(boletas[1].retencionReceptor).toBe(290000);
  });

  it('usa el CGI de emitidas por defecto', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-mensual.html'));
    await scraper.informeMensual(2025, 5);
    expect((http.postForm as jest.Mock).mock.calls[0][0])
      .toContain('TMBCOC_InformeMensualBhe.cgi');
  });

  it('usa el CGI con sufijo Rec para las recibidas', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-mensual.html'));
    await scraper.informeMensual(2025, 5, true);
    expect((http.postForm as jest.Mock).mock.calls[0][0])
      .toContain('TMBCOC_InformeMensualBheRec.cgi');
  });

  // El formulario del portal manda el mes con dos digitos; con uno solo el SII
  // responde el informe vacio en vez de un error, que es la peor combinacion.
  it('rellena el mes a dos digitos y manda pagina_solicitada', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-mensual.html'));
    await scraper.informeMensual(2025, 3);
    const campos = (http.postForm as jest.Mock).mock.calls[0][1];
    expect(campos.cbmesinformemensual).toBe('03');
    expect(campos.cbanoinformemensual).toBe('2025');
    expect(campos.pagina_solicitada).toBe('0');
    expect(campos.rut_arrastre).toBe('11111111');
  });

  it('falla si la respuesta no es un informe', async () => {
    const { scraper } = makeScraper('<html><body>Sesion expirada</body></html>');
    await expect(scraper.informeMensual(2025, 5)).rejects.toThrow(/no devolvió un informe/);
  });
});

// Emitidas y recibidas NO comparten esquema: el CGI de recibidas usa otros
// nombres de campo. Parseando con los de emitidas, cada boleta recibida salía
// con RUT "-" y nombre vacío, sin lanzar nada.
describe('BheScraper.informeMensual de recibidas', () => {
  it('parsea la contraparte como emisor, con los nombres de campo de recibidas', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-mensual-recibidas.html'));

    const boletas = await scraper.informeMensual(2025, 5, true);

    expect(boletas).toHaveLength(1);
    expect(boletas[0]).toEqual({
      folio: 3436,
      // Las recibidas también traen el código, así que su PDF se puede pedir.
      codigoBarras: '033333333034364C969E7',
      // El CGI de recibidas no emite fechaemision_N: la fecha vive en
      // fecha_boleta_N. Tampoco trae el mail de envío, así que los dos van
      // vacíos en vez de inventar un valor.
      fecha: '05/05/2025',
      fechaEmision: '',
      emailEnvio: '',
      sociedadProfesional: false,
      // El informe de recibidas no trae quién emitió como "usuario".
      usuarioEmisor: '',
      contraparteRol: 'emisor',
      contraparteRut: '33333333-3',
      contraparteNombre: 'PEDRO GOMEZ LARRAIN',
      honorarioBruto: 500000,
      // El receptor no ve la retención declarada por el emisor: el campo no
      // existe en esta respuesta, y null lo dice sin inventar un cero.
      retencionEmisor: null,
      retencionReceptor: 0,
      totalLiquido: 500000,
      anulada: false,
    });
  });
});

describe('BheScraper.informeMensual con más de una página', () => {
  // El CGI entrega 100 filas por página. Antes esto fallaba a propósito porque
  // no sabíamos cómo pedir la página 2; sí se podía saber: el propio informe
  // arma su paginador con `tot_pag = Math.ceil(max/100)` y `listar(i)` para i en
  // [0, tot_pag), poniendo ese i (0-based) en `pagina_solicitada`.
  function paginaCon(totalMes: number, folios: number[]): string {
    const filas = folios.map((folio, i) => `
 arr_informe_mensual['nroboleta_${i + 1}'] = "${folio}";
 arr_informe_mensual['codigobarras_${i + 1}'] = "COD${folio}";
 arr_informe_mensual['totalhonorarios_${i + 1}'] = formatMiles("1000",'.');`).join('');
    return `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "${totalMes}";
CantidadFilas=${folios.length};
${filas}
</script></html>`;
  }

  it('junta todas las páginas y devuelve el mes completo', async () => {
    const primeraPagina = Array.from({ length: 100 }, (_, i) => 300 + i);
    const segundaPagina = [400, 401, 402];
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce(paginaCon(103, primeraPagina))
      .mockResolvedValueOnce(paginaCon(103, segundaPagina));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas).toHaveLength(103);
    // Y en orden, sin duplicar: el bug que el error explícito evitaba era
    // justamente devolver dos veces la primera página.
    expect(boletas[0].folio).toBe(300);
    expect(boletas[102].folio).toBe(402);
  });

  it('pide las páginas con el índice 0-based que usa el CGI', async () => {
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce(paginaCon(150, Array.from({ length: 100 }, (_, i) => 300 + i)))
      .mockResolvedValueOnce(paginaCon(150, Array.from({ length: 50 }, (_, i) => 400 + i)));

    await scraper.informeMensual(2025, 5);

    const pedidas = (http.postForm as jest.Mock).mock.calls.map(([, c]) => c.pagina_solicitada);
    expect(pedidas).toEqual(['0', '1']);
  });

  it('no pide una segunda página cuando el mes entra en una', async () => {
    const { scraper, http } = makeScraper(
      paginaCon(3, [301, 302, 303])
    );

    await scraper.informeMensual(2025, 5);

    expect((http.postForm as jest.Mock).mock.calls).toHaveLength(1);
  });

  // Si el SII dijo N y juntamos otra cantidad, algo se perdió o se duplicó. Un
  // listado incompleto presentado como el mes completo entra al motor contable
  // del consumidor como un total real, así que se verifica en vez de confiar.
  it('falla si el total no coincide con lo recuperado', async () => {
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValue(paginaCon(103, Array.from({ length: 100 }, (_, i) => 300 + i)));

    await expect(scraper.informeMensual(2025, 5))
      .rejects.toThrow(/informó 103 boletas.*se recuperaron 200/s);
  });

  // Sólo con el conteo, un CGI que ignorara `pagina_solicitada` y devolviera dos
  // veces la misma página pasaría inadvertido en un mes de exactamente 200: 200
  // filas, 200 == 200, y el consumidor recibiría 100 boletas duplicadas como si
  // fueran el mes completo.
  it('detecta páginas duplicadas aunque el conteo cuadre', async () => {
    const pagina = Array.from({ length: 100 }, (_, i) => 300 + i);
    const { scraper, http } = makeScraper('');
    // El CGI ignora el índice y devuelve siempre la primera página.
    (http.postForm as jest.Mock).mockResolvedValue(paginaCon(200, pagina));

    await expect(scraper.informeMensual(2025, 5))
      // El mensaje nombra la causa: repetidos, no faltantes.
      .rejects.toThrow(/100 documento\(s\) repetido\(s\).*pagina servida dos veces|100 documento\(s\) repetido\(s\)/s);
  });

  // Recibidas pagina DISTINTO: 1-based y encadenando el código de continuación
  // que trae cada página (`pagina_sig_codigo`), con "00000000000000" como fin.
  // Es el protocolo que apigateway expone hacia afuera y ellos scrapean este
  // mismo CGI. No hay captura de un mes real con más de 100 recibidas —ninguna
  // credencial pasa de seis—, así que lo que hace segura la implementación son
  // los chequeos de integridad de abajo, no la fe en el protocolo.
  function paginaRecibidasCon(totalMes: number, folios: number[], sigCodigo: string): string {
    const filas = folios.map((folio, i) => `
 arr_informe_mensual['nroboleta_${i + 1}'] = "${folio}";
 arr_informe_mensual['codigobarras_${i + 1}'] = "REC${folio}";
 arr_informe_mensual['rutemisor_${i + 1}'] = "33333333";
 arr_informe_mensual['dvemisor_${i + 1}'] = "3";
 arr_informe_mensual['nombre_emisor_${i + 1}'] = "EMISOR DE PRUEBA";
 arr_informe_mensual['fecha_boleta_${i + 1}'] = "05/05/2025";
 arr_informe_mensual['totalhonorarios_${i + 1}'] = formatMiles("1000",'.');`).join('');
    return `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "${totalMes}";
 xml_values['pagina_sig_codigo'] = "${sigCodigo}";
CantidadFilas=${folios.length};
${filas}
</script></html>`;
  }
  const cien = Array.from({ length: 100 }, (_, i) => 300 + i);

  it('recibidas: encadena pagina_sig_codigo y junta el mes completo', async () => {
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce(paginaRecibidasCon(150, cien, 'ABC123'))
      .mockResolvedValueOnce(paginaRecibidasCon(150, Array.from({ length: 50 }, (_, i) => 500 + i), '00000000000000'));

    const boletas = await scraper.informeMensual(2025, 5, true);

    expect(boletas).toHaveLength(150);
    const pedidos = (http.postForm as jest.Mock).mock.calls.map(([, c]) => c);
    // La primera página va sin código; la segunda lleva el índice 1-based Y el
    // código que devolvió la primera. Mandar el índice de emitidas (0 y 1)
    // pediría dos veces la misma página.
    expect(pedidos[0].pagina_sig_codigo).toBeUndefined();
    expect(pedidos[1]).toMatchObject({ pagina_solicitada: '2', pagina_sig_codigo: 'ABC123' });
  });

  // Si el informe declara más páginas pero no da código de continuación, pedir
  // "la siguiente" con el índice devolvería la primera otra vez. Se corta antes.
  it('recibidas: sin código de continuación falla explícito sin pedir otra página', async () => {
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock).mockResolvedValue(paginaRecibidasCon(150, cien, '00000000000000'));

    await expect(scraper.informeMensual(2025, 5, true)).rejects.toThrow(/código de continuación/);
    expect((http.postForm as jest.Mock).mock.calls).toHaveLength(1);
  });

  // La red de seguridad: si el protocolo resultara distinto y el CGI sirviera dos
  // veces la misma página, el conteo puede cuadrar (200 == 200) y aun así ser
  // basura. Los duplicados por folio+código lo atajan.
  it('recibidas: una página servida dos veces se detecta como duplicados', async () => {
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce(paginaRecibidasCon(200, cien, 'ABC123'))
      .mockResolvedValueOnce(paginaRecibidasCon(200, cien, '00000000000000'));

    await expect(scraper.informeMensual(2025, 5, true)).rejects.toThrow(/repetido/);
  });

  it('recibidas: menos filas que el total declarado es un descuadre explícito', async () => {
    const { scraper, http } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce(paginaRecibidasCon(150, cien, 'ABC123'))
      .mockResolvedValueOnce(paginaRecibidasCon(150, [900, 901], '00000000000000'));

    await expect(scraper.informeMensual(2025, 5, true)).rejects.toThrow(/se recuperaron 102/);
  });

  // El descuadre es determinístico: reintentar hace invalidate() +
  // authenticateOnly() + las N páginas otra vez para fallar igual, gastando DOS
  // sesiones del SII en una consulta — el bloqueo 01.01.190.500.720.27 que el
  // resto del archivo cuida. Por eso es LimitacionConocida y no Error pelado.
  it('un descuadre no se reintenta ni abre una segunda sesión', async () => {
    const { scraper, http, session } = makeScraper('');
    (http.postForm as jest.Mock).mockResolvedValue(
      paginaCon(103, Array.from({ length: 100 }, (_, i) => 300 + i))
    );

    await expect(scraper.informeMensual(2025, 5)).rejects.toThrow(LimitacionConocida);

    expect(session.invalidate).not.toHaveBeenCalled();
    // Dos páginas de la única tanda, no cuatro de dos tandas.
    expect((http.postForm as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('acepta un mes de exactamente 100 boletas sin pedir otra página', async () => {
    const { scraper, http } = makeScraper(
      paginaCon(100, Array.from({ length: 100 }, (_, i) => 300 + i))
    );

    expect(await scraper.informeMensual(2025, 5)).toHaveLength(100);
    expect((http.postForm as jest.Mock).mock.calls).toHaveLength(1);
  });
});

// El PDF se pide por código de barras a un CGI distinto (TMBCOT_, no TMBCOC_)
// y la respuesta es binaria, así que no pasa por el parser de informes.
describe('BheScraper.pdfBoleta', () => {
  const PDF = Buffer.from('%PDF-1.3\n...bytes...', 'latin1');

  function makePdfScraper(
    respuesta: { contenido: Buffer; contentType: string }
  ) {
    const { scraper, http, session } = makeScraper('<html></html>');
    (http.getBinario as jest.Mock).mockResolvedValue(respuesta);
    return { scraper, http, session };
  }

  it('devuelve los bytes del PDF tal cual', async () => {
    const { scraper } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    const pdf = await scraper.pdfBoleta('111111110000048F99ED');

    expect(pdf).toEqual(PDF);
  });

  it('pide el CGI del PDF con el código de barras y origen PROPIOS', async () => {
    const { scraper, http } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    await scraper.pdfBoleta('111111110000048F99ED');

    const [url, params] = (http.getBinario as jest.Mock).mock.calls[0];
    expect(url).toContain('TMBCOT_ConsultaBoletaPdf.cgi');
    expect(params).toEqual({
      txt_codigobarras: '111111110000048F99ED',
      veroriginal: 'si',
      origen: 'PROPIOS',
      enviar: 'si',
    });
  });

  it('usa origen RECIBIDOS para una boleta recibida', async () => {
    const { scraper, http } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    await scraper.pdfBoleta('033333333034364C969E7', true);

    // toEqual completo y no sólo `origen`: el resto de los parámetros también
    // tiene que viajar en el camino de recibidas, no sólo en el de emitidas.
    expect((http.getBinario as jest.Mock).mock.calls[0][1]).toEqual({
      txt_codigobarras: '033333333034364C969E7',
      veroriginal: 'si',
      origen: 'RECIBIDOS',
      enviar: 'si',
    });
  });

  // El CGI responde 200 con el HTML del formulario de login cuando la sesión no
  // le sirve: sin mirar el Content-Type, ese HTML se entregaría como "PDF".
  it('falla si el SII responde algo que no es un PDF', async () => {
    const { scraper } = makePdfScraper({
      contenido: Buffer.from('<html><title>Autenticación</title></html>', 'latin1'),
      contentType: 'text/html; charset=iso-8859-1',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/no devolvió un PDF.*text\/html/s);
  });

  // Las dos causas llegan con el mismo Content-Type, pero sólo una se arregla
  // reintentando: quien recibe el ERROR genérico del contrato REST necesita que
  // el mensaje lo diga.
  it('nombra la sesión expirada cuando el cuerpo es el formulario de login', async () => {
    const { scraper } = makePdfScraper({
      contenido: Buffer.from('<html><head><title>Autenticación</title></head></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/la sesión expiró: reintentá/);
  });

  // La razón de que el techo de tamaño lance LimitacionConocida y no Error es
  // justamente que conSesionFresca la deja pasar: reintentar una descarga que ya
  // no cupo la va a exceder otra vez, gastando una sesión sana en el camino.
  it('no reintenta cuando la respuesta excede el techo de tamaño', async () => {
    const { scraper, http, session } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });
    (http.getBinario as jest.Mock).mockRejectedValue(
      new LimitacionConocida('La respuesta del SII superó el máximo de 4194304 bytes')
    );

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/superó el máximo/);

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(1);
    expect(session.invalidate).not.toHaveBeenCalled();
  });

  // Un PDF de 0 bytes con el Content-Type correcto pasa el chequeo pero no es
  // un documento: sin esto, el tenant recibe un archivo vacío y ningún error.
  it('rechaza un PDF vacío en vez de entregarlo', async () => {
    const { scraper } = makePdfScraper({
      contenido: Buffer.alloc(0),
      contentType: 'application/pdf',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/PDF vacío.*reintentá/s);
  });

  // curl puede morir antes de escribir la marca del `-w`, y entonces el
  // transporte devuelve contentType vacío. No es evidencia de nada, así que
  // debe caer en el caso reintentable, no en uno con causa afirmada.
  it('trata un Content-Type ausente como fallo reintentable', async () => {
    const { scraper, http } = makePdfScraper({
      contenido: Buffer.from(''),
      contentType: '',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/sin Content-Type.*algo inesperado/s);

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(2);
  });

  // Texto real del portal ante un código inexistente, ajeno o basura
  // (verificado en vivo: 1403 bytes, "INFORMACION AL CONTRIBUYENTE").
  const NO_EXISTE = Buffer.from(
    '<html><title>INFORMACION AL CONTRIBUYENTE</title><body>Sr. Contribuyente: ' +
    'No existe la boleta de honorarios electrónica con la información ' +
    'especificada, favor revisar la información e intentarlo nuevamente.</body></html>',
    'latin1'
  );

  it('nombra el código inexistente cuando el portal lo dice', async () => {
    const { scraper } = makePdfScraper({ contenido: NO_EXISTE, contentType: 'text/html' });

    await expect(scraper.pdfBoleta('99999999999999999999'))
      .rejects.toThrow(/no existe una boleta con ese código de barras/);
  });

  // La clasificación es por evidencia positiva: lo que no se reconoce puede ser
  // una caída o mantención del SII, que sí se resuelve reintentando. Marcarlo
  // como permanente le negaría el reintento a un fallo transitorio.
  it('no afirma una causa cuando el cuerpo es desconocido, y deja reintentar', async () => {
    const { scraper, http, session } = makePdfScraper({
      contenido: Buffer.from('<html><title>Servicio en mantención</title></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/algo inesperado/);

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(2);
    expect(session.invalidate).toHaveBeenCalled();
  });

  // El listado deja el campo vacío cuando el SII no lo informa. Mandarlo así
  // haría que el CGI devuelva el login, y el error apuntaría a la sesión.
  it('rechaza un código de barras vacío sin consultar al SII', async () => {
    const { scraper, http, session } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    await expect(scraper.pdfBoleta('   ')).rejects.toThrow(/Falta el código de barras/);

    expect(http.getBinario as jest.Mock).not.toHaveBeenCalled();
    expect(session.authenticateOnly).not.toHaveBeenCalled();
    // Y no tira abajo la sesión: la validación va fuera de conSesionFresca, que
    // si no invalidaría una sesión sana por un input inválido del tenant.
    expect(session.invalidate).not.toHaveBeenCalled();
  });

  // conSesionFresca reintenta todo lo que no sea LimitacionConocida. Un código
  // ajeno al RUT no se arregla reautenticando: reintentarlo gasta un re-login y
  // una consulta para fallar igual.
  it('no reintenta cuando el portal informa que la boleta no existe', async () => {
    const { scraper, http, session } = makePdfScraper({
      contenido: Buffer.from(
        '<html><body>No existe la boleta de honorarios electrónica con la ' +
        'información especificada</body></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('99999999999999999999')).rejects.toThrow();

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(1);
    expect(session.invalidate).not.toHaveBeenCalled();
  });

  // La sesión caída sí se arregla reautenticando, así que acá el reintento debe
  // ocurrir: es la diferencia con el caso de arriba.
  it('reintenta cuando el SII devolvió el formulario de login', async () => {
    const { scraper, http, session } = makePdfScraper({
      contenido: Buffer.from('<html><title>Autenticación</title></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED')).rejects.toThrow();

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(2);
    expect(session.invalidate).toHaveBeenCalled();
  });
});

describe('BheScraper y el valor de arr_informe_mensual', () => {
  // El regex cortaba el valor en el primer ";", así que una razón social con
  // entidades HTML quedaba sin comilla de cierre y el nombre desaparecía.
  it('conserva una razón social que contiene punto y coma dentro del literal', async () => {
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
CantidadFilas=1;
 arr_informe_mensual['nroboleta_1'] = "311";
 arr_informe_mensual['nombrereceptor_1'] = "SOC. GARC&Iacute;A &amp; CIA";
</script></html>`;
    const { scraper } = makeScraper(html);

    const boletas = await scraper.informeMensual(2025, 5);

    // Además se decodifican las entidades: el nombre se devuelve legible.
    expect(boletas[0].contraparteNombre).toBe('SOC. GARCÍA & CIA');
  });

  it('decodifica también las entidades numéricas', async () => {
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
CantidadFilas=1;
 arr_informe_mensual['nroboleta_1'] = "311";
 arr_informe_mensual['nombrereceptor_1'] = "PE&#209;A LTDA";
</script></html>`;
    const { scraper } = makeScraper(html);

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas[0].contraparteNombre).toBe('PEÑA LTDA');
  });
});

describe('BheScraper ante una sesión caída', () => {
  // Sin invalidar, el flag de dos horas da la autenticación por buena y cada
  // reintento repite el mismo fallo hasta reiniciar el proceso: el consejo
  // "reintentá" que da el mensaje de error era el único que no podía funcionar.
  it('invalida la sesión y reintenta una vez el informe anual', async () => {
    const { scraper, http, session } = makeScraper('');
    (http.get as jest.Mock)
      .mockResolvedValueOnce('<html>Sesión expirada</html>')
      .mockResolvedValueOnce(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(informe.anio).toBe(2025);
  });

  it('invalida la sesión y reintenta una vez el informe mensual', async () => {
    const { scraper, http, session } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce('<html>Sesión expirada</html>')
      .mockResolvedValueOnce(fixture('bhe-informe-mensual.html'));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(boletas).toHaveLength(2);
  });

  it('propaga el error si tampoco funciona con la sesión nueva', async () => {
    const { scraper, session } = makeScraper('<html>Sesión expirada</html>');

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/no devolvió un informe/);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
  });
});

// El caso que hacía que el arreglo del corte por volumen se volviera en contra:
// `conSesionFresca` reintenta todo lo que no sea LimitacionConocida o
// RequiereCertificado, invalidando la sesión y repitiendo la consulta. Ante un
// corte por volumen eso abre una sesión nueva y vuelve a pegarle a un portal que
// está cortando POR exceso de consultas — o sea que el reintento prolonga el
// corte que provocó el error.
describe('BheScraper ante el corte por volumen del SII', () => {
  it('no reintenta ni invalida la sesión: propaga el corte', async () => {
    const { scraper, session, http } = makeScraper('');
    (http.get as jest.Mock).mockRejectedValue(
      new LimiteDeConsultasSii('El SII cortó las consultas por volumen')
    );

    await expect(scraper.informeAnual(2026)).rejects.toThrow(LimiteDeConsultasSii);

    // Una sola llamada: si hubiera reintentado serían dos, y la segunda contra un
    // portal que ya está cortando.
    expect((http.get as jest.Mock).mock.calls).toHaveLength(1);
    expect(session.invalidate).not.toHaveBeenCalled();
  });
});
