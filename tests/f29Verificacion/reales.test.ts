import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { leerCompacto } from '../../src/f29Verificacion/pdfCompacto';
import { verificar, ResultadoVerificacion } from '../../src/f29Verificacion/reglas';
import { anteriorPeriodo } from '../../src/f29Verificacion/plazos';

// Casos reales de un contribuyente. Ni los datos NI los montos esperados viven
// en este repositorio (es público): se apunta a ellos con F29_FIXTURES_REALES,
// un directorio con
//   f29/F29_<AAAAMM>_folio<n>.pdf     los compactos declarados
//   f29_check/captura_*.json          RCV (resumen y detalle de NC 61) y ficha
//   f29_check/esperados.json          los casos que deben salir:
//     [{ "periodo": 202607, "codigo": "736", "declarado": 0, "esperado": 123,
//        "diferencia": -123, "severidad": "error", "nota": "..." }, …]
//     (sólo se comparan los campos presentes; "codigo" admite "efectos.<campo>"
//      y "atipico.<codigo>")
// Sin la variable, la suite se salta: CI corre sólo los casos sintéticos.
const dir = process.env.F29_FIXTURES_REALES;
const correr = dir && existsSync(dir) ? describe : describe.skip;

interface Esperado {
  periodo: number; codigo: string; nota?: string;
  declarado?: number; esperado?: number; diferencia?: number; severidad?: string; valor?: number;
}

const leer = (archivo: string) => JSON.parse(readFileSync(archivo, 'utf8'));

correr('f29Verificacion contra F29 y RCV reales', () => {
  // describe.skip igual ejecuta este cuerpo: nada se lee fuera de los tests.
  const base = dir ?? '';
  const cap = () => {
    const d = join(base, 'f29_check');
    return leer(join(d, readdirSync(d).filter(f => /^captura_.*\.json$/.test(f)).sort().pop()!));
  };
  const esperados = (): Esperado[] => leer(join(base, 'f29_check', 'esperados.json'));
  const periodosConPdf = () => readdirSync(join(base, 'f29'))
    .map(f => /^F29_(\d{6})_folio\d+\.pdf$/.exec(f)?.[1]).filter(Boolean).map(Number).sort();

  const cache = new Map<number, ResultadoVerificacion>();
  const resultado = (periodo: number): ResultadoVerificacion => {
    if (cache.has(periodo)) return cache.get(periodo)!;
    const c = cap();
    const pdf = readdirSync(join(base, 'f29')).find(f => f.startsWith(`F29_${periodo}_`))!;
    const anteriores = [];
    for (let p = anteriorPeriodo(periodo), i = 0; i < 6; p = anteriorPeriodo(p), i++) {
      if (c.resumen[`${p}_VENTA`]) anteriores.unshift(c.resumen[`${p}_VENTA`]);
    }
    const r = verificar({
      periodo, fuente: 'F29', casilleros: leerCompacto(readFileSync(join(base, 'f29', pdf))).codigos,
      compras: c.resumen[`${periodo}_COMPRA`], ventas: c.resumen[`${periodo}_VENTA`],
      ncCompras: c.detalle[`${periodo}_COMPRA_61`]?.documentos ?? null,
      ventasAnteriores: anteriores, actividades: c.ficha?.actividades,
    });
    cache.set(periodo, r);
    return r;
  };

  it('cada caso de esperados.json sale como se espera', () => {
    for (const e of esperados()) {
      const r = resultado(e.periodo);
      const etiqueta = `${e.periodo} ${e.codigo}${e.nota ? ` (${e.nota})` : ''}`;
      if (e.codigo.startsWith('efectos.')) {
        expect([etiqueta, (r.efectos as any)[e.codigo.slice(8)]]).toEqual([etiqueta, e.valor]);
        continue;
      }
      const atipico = e.codigo.startsWith('atipico.');
      const cod = atipico ? e.codigo.slice(8) : e.codigo;
      const h = r.hallazgos.find(x => x.codigo === cod && /atípico/.test(x.concepto) === atipico);
      expect([etiqueta, h === undefined]).toEqual([etiqueta, false]);
      const campos = (['declarado', 'esperado', 'diferencia', 'severidad'] as const).filter(k => e[k] !== undefined);
      expect([etiqueta, Object.fromEntries(campos.map(k => [k, h![k]]))])
        .toEqual([etiqueta, Object.fromEntries(campos.map(k => [k, e[k]]))]);
    }
  });

  it('la aritmética de todos los F29 declarados cuadra', () => {
    for (const p of periodosConPdf()) {
      const malas = resultado(p).hallazgos.filter(h => h.fuenteEsperado === 'cálculo' && h.diferencia !== null && h.severidad !== 'ok');
      expect([p, malas]).toEqual([p, []]);
    }
  });

  it('regla del 528: lo declarado difiere del RCV a lo más en las NC sobre facturas tipo 46', () => {
    const c = cap();
    for (const p of periodosConPdf()) {
      const det = c.detalle[`${p}_COMPRA_61`];
      if (!det) continue;
      const nc46 = det.documentos.filter((d: any) => d.referenciaTipoDoc === 46).reduce((s: number, d: any) => s + d.montoIva, 0);
      expect([p, [0, -nc46]]).toEqual([p, expect.arrayContaining([resultado(p).hallazgos.find(h => h.codigo === '528')!.diferencia])]);
    }
  });
});
