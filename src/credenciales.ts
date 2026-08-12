import { SiiConfig } from './env';

// De dónde salen las credenciales de un RUT. La interfaz es asíncrona porque en
// producción va contra Secrets Manager; en tests y desarrollo alcanza con la
// implementación en memoria.
//
// El registro de sesiones no la conoce: recibe una factory ya armada. Esta
// interfaz es para quien construye esa factory, que es el borde de la app.
export interface ProveedorCredenciales {
  para(rut: string): Promise<SiiConfig>;
}

// Normaliza un RUT a sólo sus caracteres alfanuméricos en mayúscula, para que
// "11.111.111-1", "11111111-1" y "111111111" indexen la misma credencial. Es el
// mismo criterio de "un RUT es un RUT" que ya aplica rutaTemporalSii al nombrar
// archivos; acá se usa como clave de búsqueda.
function normalizar(rut: string): string {
  return rut.replace(/[^0-9kK]/g, '').toUpperCase();
}

export class CredencialesEnMemoria implements ProveedorCredenciales {
  private porRut = new Map<string, SiiConfig>();

  constructor(configs: SiiConfig[]) {
    for (const config of configs) {
      this.porRut.set(normalizar(config.rut), config);
    }
  }

  async para(rut: string): Promise<SiiConfig> {
    const config = this.porRut.get(normalizar(rut));
    if (!config) {
      // No se listan los RUTs conocidos: son credenciales de clientes.
      throw new Error(`No hay credenciales registradas para el RUT ${rut}.`);
    }
    return config;
  }
}
