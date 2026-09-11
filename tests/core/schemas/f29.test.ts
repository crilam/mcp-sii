import {
  schemaEstadoF29, schemaCompactoF29, schemaPropuestaF29, schemaPpmF29,
} from '../../../src/core/schemas/f29';

// Los cuatro esquemas de F29 se COPIAN a propósito, no se alias por
// identidad (ver el comentario junto a `schemaCompactoF29`): eso deja la
// puerta abierta a que mañana alguien edite uno solo y se desincronicen sin
// que nadie lo note, porque no hay ningún error de compilación que lo avise.
// Este test fija la coincidencia de HOY contra una lista EXPLÍCITA de campos,
// sin volver a acoplar los esquemas entre sí: si alguna vez divergen a
// propósito, hay que tocar esta lista a mano, y esa edición es justo la señal
// de que alguien lo decidió en vez de que se coló solo.
const CAMPOS_ESPERADOS = ['rut', 'periodo'].sort();

describe('esquemas F29: estado, compacto, propuesta y ppm', () => {
  it.each([
    ['schemaEstadoF29', schemaEstadoF29],
    ['schemaCompactoF29', schemaCompactoF29],
    ['schemaPropuestaF29', schemaPropuestaF29],
    ['schemaPpmF29', schemaPpmF29],
  ] as const)('%s tiene exactamente los campos esperados', (_nombre, schema) => {
    expect(Object.keys(schema).sort()).toEqual(CAMPOS_ESPERADOS);
  });
});
