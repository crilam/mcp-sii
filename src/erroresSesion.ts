export class SesionNoIniciada extends Error {}
export class SesionExpirada extends Error {}

const MARCA_SIN_SESION = 'Llamá sii_iniciar_sesion primero';

export async function conErroresDeSesion<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.message.includes(MARCA_SIN_SESION)) {
      throw new SesionNoIniciada(e.message);
    }
    throw e;
  }
}
