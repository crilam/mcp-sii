import * as fs from 'fs';
import * as path from 'path';
import { parsearTramosImpuesto } from '../../src/scrapers/indicadores';

const html = fs.readFileSync(
  path.join(__dirname, '../fixtures/indicadores-impuesto2da.html'), 'utf8');
const tramos = parsearTramosImpuesto(html);

describe('parsearTramosImpuesto', () => {
  it('lee los dos meses de la página, aunque en el HTML vengan al revés', () => {
    expect(new Set(tramos.map(t => t.mes))).toEqual(new Set([1, 2]));
  });

  // El encabezado de estas tablas es "Febrero 2025", no "Febrero": si el mes se
  // buscara por igualdad exacta con el nombre, la página entera daría 0 tramos.
  it('reconoce el mes aunque el encabezado traiga el año pegado', () => {
    expect(tramos.filter(t => t.mes === 2).length).toBeGreaterThan(0);
  });

  // El SII escribe el período UNA vez y deja la celda vacía en los tramos que
  // siguen. Sin arrastrarlo, cada período se quedaría con un solo tramo.
  it('arrastra el período a los tramos que dejan la celda vacía', () => {
    const feb = tramos.filter(t => t.mes === 2);

    expect(feb.map(t => t.periodo)).toEqual(['MENSUAL', 'MENSUAL', 'DIARIO', 'DIARIO']);
  });

  // Exento no es factor cero: con 0 el consumidor calcularía "renta × 0" y
  // llegaría al mismo impuesto por un camino que la tabla no dice.
  it('marca el tramo exento y deja sus números en null', () => {
    expect(tramos.find(t => t.mes === 2 && t.periodo === 'MENSUAL')).toEqual({
      mes: 2, periodo: 'MENSUAL', desde: null, hasta: 900000,
      factor: null, rebaja: null, tasaMaxima: null, exento: true,
    });
  });

  it('lee factor, rebaja y tasa de un tramo gravado', () => {
    expect(tramos[1]).toEqual({
      mes: 2, periodo: 'MENSUAL', desde: 900000.01, hasta: 2000000,
      factor: 0.04, rebaja: 36000, tasaMaxima: 2.2, exento: false,
    });
  });

  // El último tramo no tiene tope: `hasta` va en null, no en 0.
  it('el tramo sin tope superior trae hasta en null', () => {
    const ultimo = tramos.find(t => t.periodo === 'DIARIO' && !t.exento)!;

    expect(ultimo.hasta).toBeNull();
    expect(ultimo.factor).toBe(0.4);
  });

  // Las filas del <thead> también tienen seis celdas: contar columnas no alcanza
  // para descartarlas, hace falta haber visto un período.
  it('no toma las filas de cabecera como tramos', () => {
    expect(tramos.every(t => t.periodo !== '')).toBe(true);
    expect(tramos).toHaveLength(6);
  });

  // La última tabla de la página es un pie: si el bloque del último mes se
  // extendiera hasta el final del HTML, se colaría como un tramo de enero.
  it('no arrastra la tabla de pie al último mes', () => {
    expect(tramos.filter(t => t.mes === 1)).toHaveLength(2);
  });
});
