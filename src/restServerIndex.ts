import 'dotenv/config';
import { Pool } from 'pg';
import { Browser } from './browser';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRestServer } from './restServer';

function requireEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) throw new Error(`Variable de entorno requerida no encontrada: ${nombre}`);
  return valor;
}

const pool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 10 });
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
