import 'dotenv/config';
import { Browser } from './browser';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearServidorHttp } from './httpServer';

function requireEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(`Variable de entorno requerida no encontrada: ${nombre}`);
  }
  return valor;
}

const apiKey = requireEnv('VALIDACION_API_KEY');
const port = Number(process.env.VALIDACION_PORT ?? 8787);

const credenciales = new ProveedorCredencialesRuntime();

// A diferencia de crearRegistroSesionesSii (src/registroSesionesSii.ts), acá
// cada RUT recibe su PROPIO Browser con sessionId = rut, para que
// agent-browser aísle cookies/tabs/refs entre validaciones concurrentes de
// RUTs distintos (ver spec: "Aislamiento real entre RUTs").
const registro = new RegistroSesiones<SessionManager>(async rut => {
  const config = await credenciales.para(rut);
  return new SessionManager(config, new Browser(rut));
});

const server = crearServidorHttp(registro, credenciales, apiKey);
server.listen(port, () => {
  console.log(`Servicio de validación de clave escuchando en :${port}`);
});
