import { partirRut } from '../src/rut';

// La partición del RUT estaba escrita dos veces —el RUT de la sesión y el de la
// empresa consultada en el RCV— y sólo una validaba, así que un RUT mal escrito
// fallaba distinto según por dónde entrara. Estos tests fijan la única.
describe('partirRut', () => {
  it('parte un RUT con guión', () => {
    expect(partirRut('22222222-2')).toEqual({ rut: '22222222', dv: '2' });
  });

  it('parte un RUT sin guión tomando el último carácter como dv', () => {
    expect(partirRut('222222222')).toEqual({ rut: '22222222', dv: '2' });
  });

  it('normaliza el dv K a mayúscula', () => {
    expect(partirRut('11111111-k').dv).toBe('K');
  });

  it('limpia los puntos con que el portal escribe el RUT', () => {
    expect(partirRut('11.111.111-1')).toEqual({ rut: '11111111', dv: '1' });
  });

  // Sin validación, un RUT mal escrito se parte igual y viaja al SII, que
  // responde un vacío indistinguible de "no tiene movimientos": el error
  // aparece como un resultado plausible.
  it('rechaza lo que no es un RUT', () => {
    expect(() => partirRut('no-es-un-rut')).toThrow(/inválido/);
    expect(() => partirRut('')).toThrow(/inválido/);
    expect(() => partirRut('123-4')).toThrow(/inválido/);
  });

  // El mensaje dice de qué RUT se trata: el de la sesión y el de la empresa
  // consultada se arreglan en lugares distintos.
  it('nombra en el error de qué RUT se trata', () => {
    expect(() => partirRut('xx', 'RUT de empresa')).toThrow(/RUT de empresa inválido/);
    expect(() => partirRut('xx', 'SII_RUT')).toThrow(/SII_RUT inválido/);
  });
});
