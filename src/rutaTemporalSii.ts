import * as os from 'os';
import * as path from 'path';

// Ruta de un archivo temporal de sesión (cookie jar, cert PEM, key PEM) única
// por credencial. Antes eran constantes fijas —`sii_cookies.txt` y compañía—,
// que servían para un proceso de una sola credencial pero colisionan apenas hay
// varias: dos sesiones escribiendo el mismo cookie jar se pisan y las consultas
// salen con la sesión equivocada, sin error visible.
//
// El RUT se sanea a `[A-Za-z0-9]` para que sea un nombre de archivo válido y,
// sobre todo, para que un valor con `/` o `..` no pueda apuntar el archivo fuera
// del directorio temporal. El nombre resultante lleva el RUT saneado, así que
// dos RUTs distintos dan archivos distintos y el mismo RUT da siempre el mismo.
export function rutaTemporalSii(nombre: string, rut: string): string {
  const rutSeguro = rut.replace(/[^A-Za-z0-9]/g, '') || 'sinrut';
  return path.join(os.tmpdir(), `sii_${nombre}_${rutSeguro}`);
}
