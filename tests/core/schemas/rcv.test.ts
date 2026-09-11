import { schemaAsyncSolicitar, schemaAsyncEstado, schemaAsyncDetalle } from '../../../src/core/schemas/rcv';

// Los tres esquemas del RCV async se COPIAN a propósito, no se alias por
// identidad (ver el comentario en src/core/schemas/rcv.ts): eso deja la puerta
// abierta a que mañana alguien edite uno solo y los tres se desincronicen sin
// que nadie lo note, porque no hay ningún error de compilación que lo avise.
// Este test fija la coincidencia de HOY contra una lista EXPLÍCITA de campos,
// sin volver a acoplar los esquemas entre sí: si alguna vez divergen a
// propósito, hay que tocar esta lista a mano, y esa edición es justo la señal
// de que alguien lo decidió en vez de que se coló solo.
const CAMPOS_ESPERADOS = ['rut', 'periodo', 'operacion', 'empresa_rut', 'tipo_doc'].sort();

describe('esquemas RCV async: solicitar, estado y detalle', () => {
  it.each([
    ['schemaAsyncSolicitar', schemaAsyncSolicitar],
    ['schemaAsyncEstado', schemaAsyncEstado],
    ['schemaAsyncDetalle', schemaAsyncDetalle],
  ] as const)('%s tiene exactamente los campos esperados', (_nombre, schema) => {
    expect(Object.keys(schema).sort()).toEqual(CAMPOS_ESPERADOS);
  });
});
