import { execFile } from 'child_process';
import { normalizar } from './credenciales';

// Lee la clave tributaria de un RUT desde el Llavero de macOS, para que
// sii_iniciar_sesion pueda llamarse sin la clave en los parámetros. La clave que
// viaja como parámetro de una tool pasa por el modelo y queda en el historial
// del chat; leída del Llavero, el modelo nunca la ve.
//
// Convención del ítem: servicio `mcp-sii` (o SII_LLAVERO_SERVICIO), cuenta =
// RUT normalizado (sin puntos ni guión, con dígito verificador). Se crea una vez
// desde la terminal, y `security` pide la clave sin mostrarla:
//
//   security add-generic-password -s mcp-sii -a 123456785 -w
export type LectorClave = (rut: string) => Promise<string | undefined>;

export const SERVICIO_LLAVERO_POR_DEFECTO = 'mcp-sii';

// `security find-generic-password` sale con 44 cuando el ítem no existe. Es el
// único fallo que significa "no hay clave guardada"; cualquier otro (llavero
// bloqueado, permiso denegado) se propaga para no confundirlo con una ausencia.
const ITEM_NO_ENCONTRADO = 44;

export function servicioLlavero(): string {
  return process.env.SII_LLAVERO_SERVICIO || SERVICIO_LLAVERO_POR_DEFECTO;
}

export const leerClaveDelLlavero: LectorClave = (rut) => {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    // Arreglo de argumentos, sin shell: el RUT no puede inyectar nada.
    execFile(
      'security',
      ['find-generic-password', '-s', servicioLlavero(), '-a', normalizar(rut), '-w'],
      { timeout: 10_000 },
      (error, stdout) => {
        if (!error) {
          const clave = stdout.replace(/\r?\n$/, '');
          resolve(clave || undefined);
          return;
        }
        if ((error as { code?: unknown }).code === ITEM_NO_ENCONTRADO) {
          resolve(undefined);
          return;
        }
        // El mensaje de `security` no incluye la clave, pero se reemplaza igual
        // por uno propio para no depender de eso.
        reject(new Error('No se pudo leer el Llavero de macOS'));
      }
    );
  });
};
