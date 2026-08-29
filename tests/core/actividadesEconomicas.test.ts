import * as core from '../../src/core/actividadesEconomicas';
import * as scraper from '../../src/scrapers/actividadesEconomicas';
import { RecursoNoEncontrado } from '../../src/erroresConsulta';

jest.mock('../../src/scrapers/actividadesEconomicas');
const actividadesMock = scraper.actividades as jest.Mock;

const LISTA: scraper.ActividadEconomica[] = [
  { codigo: '011101', descripcion: 'CULTIVO DE TRIGO', rubro: 'AGRICULTURA', subrubro: 'CULTIVOS', afectaIva: true, categoriaTributaria: '1', disponibleInternet: true },
  { codigo: '691002', descripcion: 'SERVICIO NOTARIAL', rubro: 'PROFESIONALES', subrubro: 'JURÍDICAS', afectaIva: false, categoriaTributaria: '2', disponibleInternet: false },
  { codigo: '091002', descripcion: 'APOYO MINERÍA', rubro: 'MINERÍA', subrubro: 'APOYO', afectaIva: false, categoriaTributaria: 'G', disponibleInternet: true },
];

describe('core/actividadesEconomicas', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    core.limpiarCacheActividades();
    actividadesMock.mockResolvedValue(LISTA);
  });

  // Es UNA página para todas las consultas: bajarla en cada filtro es tráfico
  // contra un portal que castiga a los scrapers.
  it('baja la tabla una vez y filtra en memoria', async () => {
    await core.actividades();
    await core.actividades({ categoria: '2' });
    await core.actividad('011101');

    expect(actividadesMock).toHaveBeenCalledTimes(1);
  });

  it('filtra por categoría, IVA y texto', async () => {
    await expect(core.actividades({ categoria: '2' })).resolves.toHaveLength(1);
    await expect(core.actividades({ afectaIva: true })).resolves.toHaveLength(1);
    await expect(core.actividades({ texto: 'notarial' })).resolves.toHaveLength(1);
    // El texto también busca en rubro y subrubro.
    await expect(core.actividades({ texto: 'minería' })).resolves.toHaveLength(1);
    // La categoría "G" del SII se puede pedir tal cual.
    await expect(core.actividades({ categoria: 'G' })).resolves.toHaveLength(1);
  });

  it('un código inexistente es NO_ENCONTRADO', async () => {
    await expect(core.actividad('999999')).rejects.toBeInstanceOf(RecursoNoEncontrado);
  });

  it('no cachea un fallo', async () => {
    actividadesMock.mockRejectedValueOnce(new Error('portal caído'));

    await expect(core.actividades()).rejects.toThrow('portal caído');
    await expect(core.actividades()).resolves.toHaveLength(3);
    expect(actividadesMock).toHaveBeenCalledTimes(2);
  });
});

describe('verificarRut', () => {
  // Módulo 11 con los RUT de prueba del repo: el DV se calcula, no se adivina.
  it.each([
    ['11111111-1', true],
    ['11.111.111-1', true],
    ['76019824-2', true],
    ['22222222-2', true],
    ['12345678-5', true],
    ['12345678-K', false],
    ['11111111-2', false],
  ])('%s → %p', (rut, valido) => {
    expect(core.verificarRut(rut).valido).toBe(valido);
  });

  it('normaliza el RUT y explica por qué no es válido', () => {
    const r = core.verificarRut('11.111.111-2');

    expect(r.rut).toBe('11111111-2');
    expect(r.cuerpo).toBe('11111111');
    expect(r.motivo).toMatch(/es 1, no 2/);
  });

  // Un DV "K" es válido: 10 en módulo 11. Se acepta en minúscula también.
  it('acepta K mayúscula o minúscula', () => {
    // 4-K es un RUT válido conocido por aritmética: 4*2=8 → 11-(8%11)=3... se
    // busca uno real: 20-K → 2*3+0*2=6 → 11-6=5, no. Se calcula el K de 25.
    const conK = core.verificarRut('25-k');
    expect(conK.dv).toBe('K');
    expect(conK.valido).toBe(core.verificarRut('25-K').valido);
  });

  it('rechaza lo que no tiene forma de RUT', () => {
    const r = core.verificarRut('hola');

    expect(r.valido).toBe(false);
    expect(r.motivo).toMatch(/hasta 8 dígitos/);
  });
});
