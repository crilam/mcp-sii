import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Perfiles de credencial para verificar contra el SII real.
//
// Los dominios del servicio no se pueden verificar todos con el mismo RUT: lo
// que un contribuyente puede consultar depende de CÓMO factura y de qué es.
// La ronda 2 se descubrió bloqueada recién al relevar el portal, porque la
// credencial cargada no tenía empresas en Facturación Gratuita — un dato que
// tendría que haber sido evidente antes de empezar.
//
//   persona      — persona natural. BHE emitidas y recibidas, bienes raíces,
//                  renta.
//   mipyme       — contribuyente INSCRITO en Facturación Gratuita del SII. Es el
//                  único perfil que puede relevar el portal mipyme: si el RUT no
//                  está inscrito, el selector de empresas viene vacío y no hay
//                  nada que consultar.
//   mercado      — contribuyente que emite con software de mercado (un
//                  facturador privado, no el portal del SII). Sus DTE existen en
//                  el RCV y en las consultas de documentos, pero NO en mipyme.
//                  Es el perfil que representa a la mayoría de los clientes.
//   certificado  — el MISMO tipo de contribuyente que cualquiera de los otros,
//                  pero autenticando con certificado digital en vez de clave.
//                  No es otro contribuyente: es la otra forma de entrar. Existe
//                  aparte porque es la única credencial con la que se puede
//                  FIRMAR, y `mipyme/emitir-dte` la exige.
//
// Un mismo RUT puede cumplir dos papeles, y está bien: lo que importa es que
// cada verificación diga con cuál corre.
export type NombrePerfil = 'persona' | 'mipyme' | 'mercado' | 'certificado';

/**
 * Las dos formas de autenticar, con la misma forma que el body de las rutas
 * REST: clave tributaria O certificado. Nunca las dos — mezclarlas es lo que
 * `conCredencial` rechaza, y un perfil que las trajera juntas dejaría al script
 * eligiendo en silencio cuál usa.
 */
export type CredencialPerfil =
  | { tipo: 'clave'; clave: string }
  | { tipo: 'certificado'; certificadoBase64: string; certificadoPassword: string };

export interface PerfilVerificacion {
  nombre: NombrePerfil;
  rut: string;
  credencial: CredencialPerfil;
}

export const PERFILES: NombrePerfil[] = ['persona', 'mipyme', 'mercado', 'certificado'];

const DESCRIPCIONES: Record<NombrePerfil, string> = {
  persona: 'persona natural (BHE, bienes raíces, renta)',
  mipyme: 'inscrito en Facturación Gratuita del SII (portal mipyme)',
  mercado: 'factura con software de mercado (RCV y DTE, no mipyme)',
  certificado: 'certificado digital: la única credencial que puede FIRMAR (emitir-dte)',
};

function variables(nombre: NombrePerfil): { rut: string; clave: string } {
  const sufijo = nombre.toUpperCase();
  return { rut: `SII_${sufijo}_RUT`, clave: `SII_${sufijo}_CLAVE` };
}

function faltante(nombre: NombrePerfil, faltan: string): Error {
  return new Error(
    `Falta ${faltan} en el .env. Este perfil es el de ${DESCRIPCIONES[nombre]}, `
    + 'y no se sustituye por otra credencial: correr la verificación con el RUT '
    + 'equivocado da un resultado que no dice nada. Ver .env.example.');
}

// `~` no lo expande nadie cuando el valor viene de un archivo .env: sin esto,
// una ruta perfectamente escrita a mano falla con un ENOENT que manda a buscar
// el certificado en el lugar equivocado.
function expandirHome(ruta: string): string {
  return ruta.startsWith('~') ? path.join(os.homedir(), ruta.slice(1)) : ruta;
}

/**
 * El certificado se guarda en el `.env` como una RUTA a un archivo, no como
 * base64: es un binario de varios KB y meterlo en una variable de entorno lo
 * vuelve ilegible y fácil de truncar. Las rutas REST reciben base64, así que la
 * conversión pasa acá — en un solo lugar, y no en cada script.
 */
function leerCertificado(nombre: NombrePerfil): CredencialPerfil {
  const rutaCruda = (process.env.SII_CERT_PATH ?? '').trim();
  const password = process.env.SII_CERT_PASSWORD ?? '';

  if (rutaCruda === '' || password === '') {
    const faltan = [rutaCruda === '' ? 'SII_CERT_PATH' : null,
      password === '' ? 'SII_CERT_PASSWORD' : null].filter(Boolean).join(' y ');
    throw faltante(nombre, faltan);
  }

  const ruta = expandirHome(rutaCruda);

  if (!fs.existsSync(ruta)) {
    throw new Error(
      `SII_CERT_PATH apunta a ${ruta}, que no existe. El certificado es un `
      + 'archivo .pfx o .p12 en disco; el .env guarda su ruta, no su contenido.');
  }

  return {
    tipo: 'certificado',
    certificadoBase64: fs.readFileSync(ruta).toString('base64'),
    certificadoPassword: password,
  };
}

/**
 * Devuelve el perfil pedido, o falla diciendo qué falta.
 *
 * **No hay fallback a otra credencial.** Es deliberado: si el perfil de mipyme
 * no está cargado y la función cayera en el RUT "por defecto", la verificación
 * correría contra un contribuyente distinto del que se quería probar y el
 * resultado —verde o rojo— no diría nada sobre lo que se estaba verificando.
 * Fallar acá cuesta un mensaje; el fallback cuesta una conclusión falsa.
 */
export function perfil(nombre: NombrePerfil): PerfilVerificacion {
  if (nombre === 'certificado') {
    // El titular del certificado tiene su propia variable y no se deduce de
    // `SII_RUT`: el legado usa esa para otra cosa, y adivinar el titular haría
    // firmar como un contribuyente que nadie eligió.
    const rut = (process.env.SII_CERT_RUT ?? '').trim();
    if (rut === '') throw faltante(nombre, 'SII_CERT_RUT');
    return { nombre, rut, credencial: leerCertificado(nombre) };
  }

  const { rut, clave } = variables(nombre);
  const valorRut = (process.env[rut] ?? '').trim();
  const valorClave = process.env[clave] ?? '';

  if (valorRut === '' || valorClave === '') {
    throw faltante(nombre, [valorRut === '' ? rut : null,
      valorClave === '' ? clave : null].filter(Boolean).join(' y '));
  }
  return { nombre, rut: valorRut, credencial: { tipo: 'clave', clave: valorClave } };
}

/**
 * La credencial como la esperan las rutas REST. Vive acá y no en cada script
 * para que los nombres de los campos del body estén en un solo lugar.
 */
export function credencialParaBody(p: PerfilVerificacion): Record<string, string> {
  return p.credencial.tipo === 'clave'
    ? { rut: p.rut, clave: p.credencial.clave }
    : {
      rut: p.rut,
      certificado_base64: p.credencial.certificadoBase64,
      certificado_password: p.credencial.certificadoPassword,
    };
}

/**
 * Perfiles cargados hoy, para que un script diga qué puede y qué no.
 *
 * Comprueba la EXISTENCIA del certificado sin leerlo: es una función de sondeo,
 * y cargar un .pfx entero a memoria para responder "sí, está configurado" es un
 * efecto que nadie espera de una consulta.
 */
export function perfilesDisponibles(): NombrePerfil[] {
  return PERFILES.filter(n => {
    if (n === 'certificado') {
      const ruta = (process.env.SII_CERT_PATH ?? '').trim();
      return (process.env.SII_CERT_RUT ?? '').trim() !== ''
        && (process.env.SII_CERT_PASSWORD ?? '') !== ''
        && ruta !== '' && fs.existsSync(expandirHome(ruta));
    }
    const { rut, clave } = variables(n);
    return (process.env[rut] ?? '').trim() !== '' && (process.env[clave] ?? '') !== '';
  });
}

export function descripcion(nombre: NombrePerfil): string {
  return DESCRIPCIONES[nombre];
}
