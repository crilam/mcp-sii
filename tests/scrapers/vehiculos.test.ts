import * as fs from 'fs';
import * as path from 'path';
import { parsearPlanilla, nombrePlanilla } from '../../src/scrapers/vehiculos';

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n));

describe('parsearPlanilla — livianos', () => {
  // La cabecera se ubica por NOMBRE, no por número de fila: el preámbulo del
  // SII (servicio, subdirección, notas) puede cambiar de largo entre años, y
  // asumir "fila 12" convertiría una planilla válida en cero vehículos.
  it('encuentra la cabecera después del preámbulo y lee los vehículos', async () => {
    const p = await parsearPlanilla(fixture('vehiculos-liv.xlsx'), 2026, 'liviano');

    expect(p.filas).toHaveLength(4);
    expect(p.filas[0]).toEqual({
      codigoSii: 'CB0110001', anioFabricacion: 2018, tipo: 'Cabriolet', marca: 'MARCA UNO',
      modelo: 'MODELO A', version: '4.0 CONVERTIBLE', puertas: 2, cilindrada: 4000, potencia: 510,
      combustible: 'Bencina', transmision: 'Automática', marchas: 8, traccion: '4x2 (2WD)',
      pais: 'INGLATERRA', equipamiento: 'AAF, ABS', carga: null, pasajeros: null,
      tasacion: 102510925, permiso: 4173560, observacion: '',
    });
  });

  // "Tasación 2026" y "Permiso 2026" llevan el año en el nombre de la columna:
  // sin normalizarlo, la planilla de 2027 no tendría tasación.
  it('reconoce las columnas con el año en el nombre', async () => {
    const p = await parsearPlanilla(fixture('vehiculos-liv.xlsx'), 2026, 'liviano');

    expect(p.filas[2].tasacion).toBe(9500000);
    expect(p.filas[2].permiso).toBe(350000);
    expect(p.filas[2].observacion).toBe('Nota');
  });

  // Una celda vacía es ausencia, no cero: "0 HP" sería un dato.
  it('las celdas numéricas vacías van en null', async () => {
    const p = await parsearPlanilla(fixture('vehiculos-liv.xlsx'), 2026, 'liviano');

    expect(p.filas[3].potencia).toBeNull();
    expect(p.filas[3].marchas).toBeNull();
    expect(p.filas[3].pais).toBe('');
  });

  it('no toma la nota al pie como un vehículo', async () => {
    const p = await parsearPlanilla(fixture('vehiculos-liv.xlsx'), 2026, 'liviano');

    expect(p.filas.every(f => /^[A-Z]{2}\d+$/.test(f.codigoSii))).toBe(true);
  });

  // Sin el diccionario, `equipamiento` es una lista de siglas que nadie lee.
  it('lee el diccionario de siglas de la segunda hoja', async () => {
    const p = await parsearPlanilla(fixture('vehiculos-liv.xlsx'), 2026, 'liviano');

    expect(p.equipamiento).toEqual([
      { sigla: 'AA', descripcion: 'Aire Acondicionado' },
      { sigla: 'ABS', descripcion: 'Frenos ABS' },
    ]);
  });
});

describe('parsearPlanilla — pesados', () => {
  // Pesados tiene OTRA cabecera (fila 11, con carga y pasajeros, sin permiso):
  // un parser que asumiera la de livianos fallaría o, peor, leería columnas
  // corridas.
  it('lee carga y pasajeros, y deja el permiso en null', async () => {
    const p = await parsearPlanilla(fixture('vehiculos-pes.xlsx'), 2026, 'pesado');

    expect(p.filas).toHaveLength(2);
    expect(p.filas[1]).toMatchObject({
      codigoSii: 'UR5710010', marca: 'MARCA BUS', carga: 14000, pasajeros: 63,
      tasacion: 129045539, permiso: null, puertas: null, potencia: null,
    });
    expect(p.equipamiento).toEqual([]);
  });
});

describe('parsearPlanilla — formato desconocido', () => {
  // Una planilla sin la cabecera esperada no puede convertirse en "cero
  // vehículos": eso se lee como un año sin datos, y el SII sí los publica.
  it('falla explícito si no encuentra la cabecera', async () => {
    await expect(parsearPlanilla(fixture('vehiculos-formato-desconocido.xlsx'), 2026, 'liviano'))
      .rejects.toThrow(/no tiene la cabecera esperada/);
  });
});

describe('nombrePlanilla', () => {
  it.each([
    [2026, 'liviano', 'liv2026.xlsx'],
    [2024, 'pesado', 'pes2024.xlsx'],
  ] as const)('%i %s → %s', (anio, cat, esperado) => {
    expect(nombrePlanilla(anio, cat)).toBe(esperado);
  });
});
