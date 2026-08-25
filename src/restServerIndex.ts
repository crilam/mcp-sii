import 'dotenv/config';
import { crearRegistroSesionesSii } from './registroSesionesSii';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRestServer } from './restServer';
import { getPool } from './db';

const pool = getPool();
const port = Number(process.env.PORT ?? 8790);

const credenciales = new ProveedorCredencialesRuntime();
// Se usa la factory compartida y NO se arma el registro acá: cuando esto era una
// copia, se desincronizó y quedó sin `destruir` ni id único por sesión — o sea
// un navegador vivo y un cookie jar en disco por request. El porqué de cada
// garantía está en `registroSesionesSii.ts`.
const registro = crearRegistroSesionesSii(credenciales);

const server = crearRestServer(pool, registro, credenciales);
server.listen(port, () => {
  console.log(`Adaptador REST escuchando en :${port}`);
});
