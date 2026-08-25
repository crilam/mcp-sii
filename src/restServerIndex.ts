import 'dotenv/config';
import { crearRegistroSesionesSii } from './registroSesionesSii';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRestServer } from './restServer';
import { getPool } from './db';

const pool = getPool();
const port = Number(process.env.PORT ?? 8790);

const credenciales = new ProveedorCredencialesRuntime();
// Se usa la factory compartida en vez de armar el registro a mano. La versión
// anterior repetía la construcción acá y le faltaban las DOS cosas que esa
// función existe para garantizar:
//
//   1. `destruir`. El registro llama `destruirSeguro` al terminar cada pase,
//      pero ese método no hace nada si no se le pasó uno: cada request dejaba el
//      proceso del navegador vivo y el cookie jar en disco —credenciales de
//      sesión del SII— en un servicio de larga vida y multi-tenant. Medido: 7
//      archivos por RUT tras una corrida.
//   2. El id ÚNICO por sesión. Acá se creaba el contexto con `new Browser(rut)`,
//      o sea un perfil por RUT compartido entre sesiones: exactamente la
//      herencia de cookie jar que `crearRegistroSesionesSii` documenta haber
//      eliminado, reintroducida sin que nadie lo notara.
const registro = crearRegistroSesionesSii(credenciales);

const server = crearRestServer(pool, registro, credenciales);
server.listen(port, () => {
  console.log(`Adaptador REST escuchando en :${port}`);
});
