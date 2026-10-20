import { deflateSync } from 'zlib';

// PDF mínimo con la misma forma que el compacto del SII: un stream FlateDecode
// con un objeto de texto (BT … ET) por celda. Sirve para probar el lector sin
// versionar un F29 real (el repositorio es público).
export function pdfSintetico(celdas: string[]): Buffer {
  const escapar = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const contenido = celdas
    .map((c, i) => `BT\n/F1 8 Tf\n1 0 0 -1 10 ${10 + i * 10} Tm [(${escapar(c)})] TJ\nET\n`)
    .join('');
  const comprimido = deflateSync(Buffer.from(contenido, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Metadata /Subtype /XML /Length 5 >>\nstream\nhola\nendstream\nendobj\n', 'latin1'),
    Buffer.from(`2 0 obj\n<< /Length ${comprimido.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    comprimido,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

/** Celdas de un F29 compacto con los casilleros dados (código → valor impreso). */
export function celdasF29(opts: {
  folio?: string; rut?: string; periodo?: string; tipo?: string; fecha?: string;
  casilleros: [string, string, string][];
}): string[] {
  return [
    'DECLARACIÓN MENSUAL Y PAGOSIMULTÁNEO DE IMPUESTOSFORMULARIO 29',
    'FOLIO', '[07]', opts.folio ?? '1234567890',
    'RUT', '[03]', opts.rut ?? '11.111.111-1',
    'PERIODO', '[15]', opts.periodo ?? '202601',
    '01', 'Apellido Paterno o Razón Social', 'EMPRESA DE PRUEBA S.A.',
    'Código', 'Glosa', 'Valor',
    ...opts.casilleros.flat(),
    '931', 'Monto Interés', '932', 'Monto Multa', '60', 'Condonación', '0', '0',
    'TOTAL A PAGAR DENTRO DEL PLAZO LEGAL', '91', '1.000',
    'Tipo de Declaración', 'Corrige a Folio(s)', 'Banco', 'Medio de Pago', 'Fecha de Presentación',
    opts.tipo ?? 'Primitiva', 'CHILE', 'PEL', opts.fecha ?? '19/02/2026',
    'Firma y Timbre Fiscalizador',
  ];
}
