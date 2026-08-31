import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// Sólo el RUT: el catálogo de eventos de acuse no depende de período ni empresa.
export const schemaEventosAcuse = {
  rut: z.string().min(1).describe(RUT_DESC),
};

const documento = z.object({
  rut_emisor: z.string().min(1).describe('RUT del emisor del documento, con dígito verificador (22222222-2).'),
  tipo_doc: z.number().int().positive().describe('Código del tipo de documento (33 factura electrónica, etc.).'),
  folio: z.number().int().positive().describe('Folio del documento.'),
});

export const schemaAcusar = {
  rut: z.string().min(1).describe(RUT_DESC),
  documentos: z.array(documento).min(1)
    .describe('Documentos sobre los que se acusa recibo.'),
  evento: z.string().min(1)
    .describe('Código del evento de acuse (ERM = recibo de mercaderías/servicios Ley 19.983, ERG = recibo de guía del mes anterior). Se obtiene de sii_rcv_eventos_acuse.'),
  // La barrera de la escritura: sin confirmar:true NO se cursa nada, se simula.
  confirmar: z.boolean().optional().default(false)
    .describe('false (default): SIMULA y devuelve qué se haría, sin escribir. true: CURSA el acuse real, acto irreversible con efectos legales (habilita la cesión del crédito bajo la Ley 19.983).'),
};
