import { extraerPermutaciones, extraerHashPolitica, descubrirConstantesGwt } from '../../src/scrapers/gwtConstantes';

// Fragmentos con la forma real de los archivos de la app (nombres de variables
// del bundle ofuscado), recortados.
const NOCACHE = "var Ub='AAAA1111BBBB2222CCCC3333DDDD4444',Vb='EEEE5555FFFF6666AAAA7777BBBB8888';Ub,Vb";
const BUNDLE = "Vxh='svcConsulta',TSh='svcConsultaExt';"
  + "function cHc(){qGc();Tb.call(this,ecf(),Vxh,'0123456789ABCDEF0123456789ABCDEF',pGc)}"
  + "function DUd(){sUd();Tb.call(this,ecf(),TSh,'FEDCBA9876543210FEDCBA9876543210',rUd)}";

describe('extraerPermutaciones', () => {
  it('lista los hashes de 32 hex sin repetir', () => {
    expect(extraerPermutaciones(NOCACHE)).toEqual(['AAAA1111BBBB2222CCCC3333DDDD4444', 'EEEE5555FFFF6666AAAA7777BBBB8888']);
  });
});

describe('extraerHashPolitica', () => {
  it('encuentra el hash del proxy cuya ruta viene en una variable', () => {
    expect(extraerHashPolitica(BUNDLE, 'svcConsulta')).toBe('0123456789ABCDEF0123456789ABCDEF');
  });

  // `svcConsulta` es prefijo de `svcConsultaExt`: no puede devolver el de otro servicio.
  it('no confunde un servicio con otro cuya ruta lo contiene', () => {
    expect(extraerHashPolitica(BUNDLE, 'svcConsultaExt')).toBe('FEDCBA9876543210FEDCBA9876543210');
  });

  it('acepta la ruta inline', () => {
    expect(extraerHashPolitica("Tb.call(this,ecf(),'svcConsulta','00000000000000000000000000000ABC',x)", 'svcConsulta'))
      .toBe('00000000000000000000000000000ABC');
  });

  it('devuelve null si el bundle no construye ese proxy', () => {
    expect(extraerHashPolitica(BUNDLE, 'svcOtro')).toBeNull();
  });
});

describe('descubrirConstantesGwt', () => {
  it('prueba las permutaciones y extensiones hasta encontrar el proxy', async () => {
    const get = jest.fn(async (url: string) => {
      if (url.endsWith('.nocache.js')) return NOCACHE;
      if (url.includes('AAAA1111') && url.endsWith('.cache.js')) throw new Error('404');
      if (url.includes('AAAA1111') && url.endsWith('.cache.html')) return 'sin proxies';
      if (url.includes('EEEE5555') && url.endsWith('.cache.js')) return BUNDLE;
      throw new Error('no esperado ' + url);
    });

    await expect(descubrirConstantesGwt(get, 'https://x/app', 'mod', 'svcConsulta')).resolves.toEqual({
      permutacion: 'EEEE5555FFFF6666AAAA7777BBBB8888',
      hashPolitica: '0123456789ABCDEF0123456789ABCDEF',
    });
    expect(get).toHaveBeenCalledWith('https://x/app/mod.nocache.js');
  });

  it('falla explícito si ninguna permutación construye el proxy', async () => {
    const get = jest.fn(async (url: string) => (url.endsWith('.nocache.js') ? NOCACHE : 'nada'));
    await expect(descubrirConstantesGwt(get, 'https://x/app', 'mod', 'svcConsulta')).rejects.toThrow(/No se encontró el hash/);
  });
});
