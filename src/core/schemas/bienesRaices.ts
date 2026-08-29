import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const schemaListBienesRaices = {
  rut: z.string().min(1).describe(RUT_DESC),
};

// Sólo el RUT: la lista de comunas y las solicitudes cuelgan de la sesión.
export const schemaSoloRut = {
  rut: z.string().min(1).describe(RUT_DESC),
};

// Un predio del catastro: comuna (código SII), manzana y predio. El rol que
// muestra el portal, "00632-00244", es manzana-predio con ceros a la izquierda;
// acá van como enteros, que es como los recibe la API.
const zodRol = {
  comuna: z.number().int().positive()
    .describe('Código SII de la comuna (el `codigo` que devuelve /comunas)'),
  manzana: z.number().int().nonnegative().describe('Manzana del rol (la parte izquierda de "00632-00244" → 632)'),
  predio: z.number().int().nonnegative().describe('Predio del rol (la parte derecha de "00632-00244" → 244)'),
};

export const schemaRol = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...zodRol,
};

export const schemaCertificadoAvaluo = {
  rut: z.string().min(1).describe(RUT_DESC),
  bienes: z.array(z.object({
    ...zodRol,
    ultimo_eac_aplicado: z.number().int().nonnegative()
      .describe('El `ultimoEacAplicado` que devuelve el listado de propiedades para ese predio'),
  })).min(1).max(20).describe('Predios a certificar, tal como los devuelve el listado de propiedades'),
  tipo: z.enum(['simple', 'multipropietario', 'detallado']).default('simple')
    .describe('simple (default), multipropietario (incluye copropietarios) o detallado'),
};

export const schemaDocumento = {
  rut: z.string().min(1).describe(RUT_DESC),
  // Se acepta tal cual la publica la lista de solicitudes: es un identificador
  // opaco con la forma /descarga/documento/{codigo}/{folio}. El scraper valida
  // la forma antes de pegarla a una URL.
  url: z.string().regex(/^\/descarga\/documento\/[A-Za-z0-9-]+\/[A-Za-z0-9]+$/,
    'url debe ser la que devuelve /solicitudes (/descarga/documento/{codigo}/{folio})')
    .describe('La `url` de una solicitud, tal como la devuelve /solicitudes'),
};
