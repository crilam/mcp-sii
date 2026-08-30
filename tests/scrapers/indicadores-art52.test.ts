import * as fs from 'fs';
import * as path from 'path';
import { parsearTramosImpuesto } from '../../src/scrapers/indicadores';

// La página del artículo 52 bis es OTRA que la del 43 y difiere en tres cosas
// (h3 en vez de h2, un solo período, celdas con <div align>), pero el código la
// parsea con la MISMA función. Sin este fixture, la única variante cubierta era
// la del 43: el parser que falla ruidosamente si no reconoce ningún rótulo
// quedaba sin probar justo para la página donde ese rótulo cambia.
const html = fs.readFileSync(
  path.join(__dirname, '../fixtures/indicadores-impuesto2da-art52.html'), 'utf8');
const tramos = parsearTramosImpuesto(html);

describe('parsearTramosImpuesto — página del artículo 52 bis', () => {
  it('reconoce los meses aunque vengan titulados con h3 y no con h2', () => {
    expect(new Set(tramos.map(t => t.mes))).toEqual(new Set([1, 2]));
  });

  // Esta página trae sólo MENSUAL. Que el parser devuelva algo no alcanza: si
  // inventara períodos, la tabla de sueldos saldría con tramos que no existen.
  it('sólo emite el período MENSUAL, que es el único que esta página publica', () => {
    expect(new Set(tramos.map(t => t.periodo))).toEqual(new Set(['MENSUAL']));
  });

  // El valor va dentro de un <div align=...>: si se leyera la celda sin
  // desarmar el div, el número saldría null y el tramo quedaría vacío.
  it('lee los montos aunque estén envueltos en un div dentro de la celda', () => {
    const feb = tramos.filter(t => t.mes === 2);
    const segundo = feb[1];

    expect(segundo.desde).toBe(900000.01);
    expect(segundo.hasta).toBe(2000000);
    expect(segundo.factor).toBe(0.04);
    expect(segundo.rebaja).toBe(36000);
  });

  it('marca el exento sin números, igual que en la página del 43', () => {
    const exento = tramos.find(t => t.exento)!;

    expect(exento.factor).toBeNull();
    expect(exento.rebaja).toBeNull();
    expect(exento.hasta).toBe(900000);
  });

  // El último tramo no tiene tope: `-.-` en "Hasta" es "sin límite", no cero.
  it('deja en null el tope del último tramo', () => {
    const feb = tramos.filter(t => t.mes === 2);

    expect(feb[feb.length - 1].hasta).toBeNull();
  });
});
