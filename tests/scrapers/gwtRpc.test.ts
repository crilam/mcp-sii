import { codificarLong, decodificarLong, leerRespuestaGwt } from '../../src/scrapers/gwtRpc';

describe('longs GWT', () => {
  /*
   * Valores medidos contra la app real: "xdp" es el período 202601 y "Hc1lAB" un
   * folio. Si la codificación se corriera, el sobre pediría otro contribuyente u
   * otro período sin ningún error.
   *
   * Había un par más cuyo número era el RUT real de un contribuyente. Se quitó:
   * este repositorio es público y un RUT real versionado es una filtración. No
   * se reemplazó por uno ficticio porque un par calculado con nuestra propia
   * función no probaría nada sobre la app real —sería circular, y para eso ya
   * está el test de ida y vuelta de abajo—; el anclaje contra la medición lo
   * siguen dando los pares que quedan, que no identifican a nadie.
   */
  it.each([
    ['xdp', 202601],
    ['Hc1lAB', 8000000001],
    ['A', 0],
  ])('%s <-> %d', (texto, numero) => {
    expect(decodificarLong(texto)).toBe(numero);
    expect(codificarLong(numero)).toBe(texto);
  });

  it('ida y vuelta para un rango de valores', () => {
    for (const n of [1, 63, 64, 4095, 100000, 202512, 9999999999]) {
      expect(decodificarLong(codificarLong(n))).toBe(n);
    }
  });

  it('un carácter fuera del alfabeto es un error', () => {
    expect(() => decodificarLong('a-b')).toThrow(/fuera del alfabeto/);
  });
});

describe('leerRespuestaGwt', () => {
  /*
   * Respuesta REAL de getFoliosConsulta (anonimizada en los ids). Los longs van
   * entre comillas simples y la tabla de strings entre dobles: no es JSON.
   *
   * La anonimización decía estar hecha y el RUT seguía acá: viajaba CODIFICADO
   * como long de GWT, así que no se veía como un RUT ni al leerlo ni para el
   * chequeo de privacidad —y el decodificador que lo devuelve está en el archivo
   * de al lado—. Ahora el token es el de un RUT ficticio. Ninguna aserción de
   * este describe lo mira: se afirman el folio, el período y la tabla.
   */
  const OK = `//OK[-7,-7,4,24,23,22,-7,'xdp',5,21,20,'tcaQa',5,'xdp',5,'C5Z20',5,19,0,18,'Hc1lAB',5,17,'A',5,0,-6,16,15,14,1,3,13,12,11,10,9,8,0,7,'WFX5y',5,6,'BUxWO',5,4,2026,3,2,1,1,["java.util.Vector/3057315478","cl.sii.sdi.sifm.commons.to.consulta.FolioPeriodoFormularioTO/3253336399","java.lang.Integer/3438268394","2","java.lang.Long/4227064769","SINOBS","DRCP","Vigente","AMBOS","29","F29 - Declaración Mensual","Declaración Mensual","MES","DPS","G1515000gym","MPD_PLANT","20/02/2026","800000001","CLP","2026-02-20 22:45:21.0","N","OPVPHHA","M01","CRCIVA"],0,7]`;

  it('resuelve los longs y los índices a la tabla de strings', () => {
    const { stream, tabla } = leerRespuestaGwt(OK);

    // El folio (long de 10 dígitos) y el codInt (string de la tabla) aparecen
    // resueltos en el stream.
    expect(stream).toContain(8000000001);
    expect(stream).toContain(202601);
    expect(tabla).toContain('800000001');
    expect(tabla).toContain('Vigente');
  });

  // Sin `//OK` no es una respuesta: es el login o un cambio de la app, y no
  // puede leerse como "sin datos".
  it('una respuesta que no empieza con //OK falla explícito', () => {
    expect(() => leerRespuestaGwt('<html>Ingreso de RUT y clave</html>')).toThrow(/no devolvió \/\/OK/);
  });

  // GWT devuelve `//EX[...]` cuando el sobre está mal formado o la sesión no
  // sirve; distinguirlo del OK evita reportar "sin datos".
  it('una excepción GWT (//EX) se reconoce como tal', () => {
    expect(() => leerRespuestaGwt('//EX[2,1,["com.google.gwt.user.client.rpc.IncompatibleRemoteServiceException/3936916533"],0,7]'))
      .toThrow(/excepción/);
  });
});
