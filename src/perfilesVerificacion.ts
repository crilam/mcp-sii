// Perfiles de credencial para verificar contra el SII real.
//
// Los dominios del servicio no se pueden verificar todos con el mismo RUT: lo
// que un contribuyente puede consultar depende de CÓMO factura y de qué es.
// La ronda 2 se descubrió bloqueada recién al relevar el portal, porque la
// credencial cargada no tenía empresas en Facturación Gratuita — un dato que
// tendría que haber sido evidente antes de empezar.
//
//   persona  — persona natural. BHE emitidas y recibidas, bienes raíces, renta.
//   mipyme   — contribuyente INSCRITO en Facturación Gratuita del SII. Es el
//              único perfil que puede relevar el portal mipyme: si el RUT no
//              está inscrito, el selector de empresas viene vacío y no hay nada
//              que consultar.
//   mercado  — contribuyente que emite con software de mercado (un facturador
//              privado, no el portal del SII). Sus DTE existen en el RCV y en
//              las consultas de documentos, pero NO en mipyme. Es el perfil que
//              representa a la mayoría de los clientes reales.
//
// Un mismo RUT puede cumplir dos papeles, y está bien: lo que importa es que
// cada verificación diga con cuál corre.
export type NombrePerfil = 'persona' | 'mipyme' | 'mercado';

export interface PerfilVerificacion {
  nombre: NombrePerfil;
  rut: string;
  clave: string;
}

export const PERFILES: NombrePerfil[] = ['persona', 'mipyme', 'mercado'];

const DESCRIPCIONES: Record<NombrePerfil, string> = {
  persona: 'persona natural (BHE, bienes raíces, renta)',
  mipyme: 'inscrito en Facturación Gratuita del SII (portal mipyme)',
  mercado: 'factura con software de mercado (RCV y DTE, no mipyme)',
};

function variables(nombre: NombrePerfil): { rut: string; clave: string } {
  const sufijo = nombre.toUpperCase();
  return { rut: `SII_${sufijo}_RUT`, clave: `SII_${sufijo}_CLAVE` };
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
  const { rut, clave } = variables(nombre);
  const valorRut = (process.env[rut] ?? '').trim();
  const valorClave = process.env[clave] ?? '';

  if (valorRut === '' || valorClave === '') {
    const faltan = [valorRut === '' ? rut : null, valorClave === '' ? clave : null]
      .filter(Boolean).join(' y ');
    throw new Error(
      `Falta ${faltan} en el .env. Este perfil es el de ${DESCRIPCIONES[nombre]}, `
      + 'y no se sustituye por otra credencial: correr la verificación con el RUT '
      + 'equivocado da un resultado que no dice nada. Ver .env.example.');
  }
  return { nombre, rut: valorRut, clave: valorClave };
}

/** Perfiles cargados hoy, para que un script diga qué puede y qué no. */
export function perfilesDisponibles(): NombrePerfil[] {
  return PERFILES.filter(n => {
    const { rut, clave } = variables(n);
    return (process.env[rut] ?? '').trim() !== '' && (process.env[clave] ?? '') !== '';
  });
}

export function descripcion(nombre: NombrePerfil): string {
  return DESCRIPCIONES[nombre];
}
