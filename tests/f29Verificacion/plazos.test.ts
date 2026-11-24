import { periodoVencido, vencimiento, estadoPlazo, fechaIso } from '../../src/f29Verificacion/plazos';

describe('f29Verificacion/plazos', () => {
  it('el período vencido es el mes anterior', () => {
    expect(periodoVencido(new Date(2026, 9, 20))).toBe(202609);
    expect(periodoVencido(new Date(2026, 0, 5))).toBe(202512);
  });

  it('vence el 20 (o el 12) del mes siguiente y corre al hábil si cae en fin de semana o feriado', () => {
    expect(fechaIso(vencimiento(202601, 20))).toBe('2026-02-20');
    expect(fechaIso(vencimiento(202605, 20))).toBe('2026-06-22'); // sábado 20
    expect(fechaIso(vencimiento(202609, 12))).toBe('2026-10-13'); // lunes 12 feriado
    expect(fechaIso(vencimiento(202601, 12, ['2026-02-12']))).toBe('2026-02-13');
  });

  it('distingue vigente, fuera de plazo y no presentado', () => {
    const vence = new Date(2026, 9, 20);
    expect(estadoPlazo({ fechaPresentacion: '20/10/2026' }, vence, new Date(2026, 9, 21))).toBe('vigente');
    expect(estadoPlazo({ fechaPresentacion: '21/10/2026' }, vence, new Date(2026, 9, 21))).toBe('vigente fuera de plazo');
    expect(estadoPlazo(null, vence, new Date(2026, 9, 20))).toBe('no presentado, dentro de plazo');
    expect(estadoPlazo(null, vence, new Date(2026, 9, 21))).toBe('no presentado');
  });
});
