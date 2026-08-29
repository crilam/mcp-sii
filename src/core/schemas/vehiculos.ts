import { z } from 'zod';

// Sin `rut` ni credencial: las planillas de tasación son públicas, igual que
// los indicadores. El SII publica XLSX desde 2020.
const base = {
  anio: z.number().int().min(2020).max(2100)
    .describe('Año de la planilla de tasación (el del permiso de circulación), no el de fabricación. XLSX desde 2020.'),
  categoria: z.enum(['liviano', 'pesado']).default('liviano')
    .describe('liviano (autos, camionetas, motos...) o pesado (camiones, buses, maquinaria)'),
};

export const schemaVehiculosBase = base;

export const schemaMarcas = {
  ...base,
  tipo: z.string().min(1).optional().describe('Filtrar por tipo de vehículo (Sedán, Suv, Camioneta...), como lo devuelve /tipos'),
};

export const schemaModelos = {
  ...base,
  marca: z.string().min(1).describe('Marca, como la devuelve /marcas'),
};

export const schemaTasacion = {
  ...base,
  codigo_sii: z.string().min(1).optional().describe('Código SII del vehículo (ej. "CB0110001"). Si se pasa, marca y modelo son opcionales.'),
  marca: z.string().min(1).optional(),
  modelo: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  anio_fabricacion: z.number().int().min(1900).max(2100).optional().describe('Año de fabricación del vehículo'),
};

// Zod no puede expresar "código_sii O (marca Y modelo)" en el objeto plano; se
// valida en un refine para que el 400 diga qué falta en vez de un ERROR del core.
export const refinarTasacion = (d: { codigo_sii?: string; marca?: string; modelo?: string }) =>
  Boolean(d.codigo_sii) || Boolean(d.marca && d.modelo);
export const MENSAJE_REFINE_TASACION = 'Hace falta codigo_sii, o marca y modelo';
