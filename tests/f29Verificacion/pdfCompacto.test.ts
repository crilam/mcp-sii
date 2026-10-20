import { leerCompacto, numeroF29, PdfF29Ilegible } from '../../src/f29Verificacion/pdfCompacto';
import { pdfSintetico, celdasF29 } from './pdfSintetico';

describe('f29Verificacion/pdfCompacto', () => {
  it('lee encabezado y casilleros con miles con punto', () => {
    const pdf = pdfSintetico(celdasF29({
      casilleros: [
        ['519', 'CANT. DE DCTOS. FACT. RECIB. DEL GIRO', '83'],
        ['115', 'TASA PPM 1ra. CATEGORÍA', '0.25'],
        ['039', 'IVA TOT RET. TERC.(TASA ART. 14)', '3.249.446'],
        ['520', 'CRÉDITO REC. Y REINT./FACT. DEL GIRO', '12.135.145'],
        ['089', 'IMP. DETERM. IVA', '0'],
      ],
    }));

    const f = leerCompacto(pdf);

    expect(f).toMatchObject({
      folio: 1234567890, periodo: 202601, rut: '11111111-1',
      tipoDeclaracion: 'Primitiva', fechaPresentacion: '19/02/2026',
    });
    expect(f.codigos).toMatchObject({ '519': 83, '115': 0.25, '039': 3249446, '520': 12135145, '089': 0 });
    expect(f.glosas['039']).toBe('IVA TOT RET. TERC.(TASA ART. 14)');
  });

  it('salta los casilleros impresos sin valor (931, 932) sin correr el siguiente', () => {
    const f = leerCompacto(pdfSintetico(celdasF29({ casilleros: [['502', 'DÉBITOS FACTURAS EMITIDAS', '1.000']] })));
    expect(f.codigos['931']).toBeUndefined();
    expect(f.codigos['932']).toBeUndefined();
    expect(f.codigos['502']).toBe(1000);
  });

  it('falla explícito si el PDF no trae la tabla (no devuelve un F29 en cero)', () => {
    expect(() => leerCompacto(pdfSintetico(['otra cosa']))).toThrow(PdfF29Ilegible);
  });

  it('numeroF29 distingue miles de decimales', () => {
    expect(numeroF29('1.153')).toBe(1153);
    expect(numeroF29('0.25')).toBe(0.25);
    expect(numeroF29('-1.234.567')).toBe(-1234567);
    expect(numeroF29('PEL')).toBeNull();
  });
});
