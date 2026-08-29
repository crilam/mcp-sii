import { z } from 'zod';
import { RUT_DESC } from './rcv';

export const schemaFichaContribuyente = {
  rut: z.string().min(1).describe(RUT_DESC),
};
