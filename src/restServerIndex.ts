import 'dotenv/config';
import { Browser } from './browser';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRestServer } from './restServer';
import { getPool } from './db';

const pool = getPool();
const port = Number(process.env.PORT ?? 8790);

const credenciales = new ProveedorCredencialesRuntime();
const registro = new RegistroSesiones<SessionManager>(async rut => {
  const config = await credenciales.para(rut);
  return new SessionManager(config, new Browser(rut));
});

const server = crearRestServer(pool, registro, credenciales);
server.listen(port, () => {
  console.log(`Adaptador REST escuchando en :${port}`);
});
