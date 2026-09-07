import * as fs from 'fs';
import * as path from 'path';

// Los fixtures de `docs/relevamientos/fixtures/` documentan la forma REAL de las
// respuestas del SII, y otros proyectos los usan para tipar su cliente. Sin un
// test que los cargue son documentación que se pudre en silencio: alguien los
// "ordena", convierte los montos a número, y nadie se entera hasta que el
// consumidor rompe contra el SII de verdad.
//
// Esto NO prueba el comportamiento de mcp-sii: prueba que los fixtures sigan
// siendo lo que dicen ser.
const DIR = path.join(__dirname, '..', '..', 'docs', 'relevamientos', 'fixtures');

function leer(nombre: string): any {
  return JSON.parse(fs.readFileSync(path.join(DIR, nombre), 'utf-8'));
}

describe('fixtures del F29', () => {
  // Que sean JSON válido es el punto: la primera versión llevaba comentarios `//`
  // adentro y no los podía cargar nadie.
  it('todos son JSON parseable', () => {
    const archivos = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
    expect(archivos.length).toBeGreaterThanOrEqual(5);
    for (const a of archivos) expect(() => leer(a)).not.toThrow();
  });

  it('la propuesta trae los montos como STRING, no como número', () => {
    const p = leer('f29-propuesta-declaracion-con-condiciones.json');

    expect(Array.isArray(p.listCodPropuestos)).toBe(true);
    for (const c of p.listCodPropuestos) {
      expect(typeof c.codigo).toBe('string');
      expect(typeof c.valor).toBe('string');
    }
    // `tipopropuesta` en cambio es number: la mezcla es del SII, no un descuido.
    expect(typeof p.tipopropuesta).toBe('number');
  });

  // Las dos convenciones de "sin datos" que conviven en la misma aplicación. Si
  // alguien las unifica en el fixture, el cliente que se escriba con él va a
  // tratar mal uno de los dos casos.
  it('boletas sin datos usa ceros y lista vacía', () => {
    const b = leer('f29-boletas-honorario-vacio.json');

    expect(b.listBoletasHonorarios).toEqual([]);
    expect(b.honorariosBrutoTotal).toBe(0);
    expect(b.totalRegistros).toBe(0);
  });

  it('asistentes sin datos usa null por posición, y el array es posicional', () => {
    const a = leer('f29-complementos-asistentes-vacio.json');

    expect(Array.isArray(a)).toBe(true);
    // Tres posiciones: tipo 1, tipo 2 y tipo 3 (PPM).
    expect(a).toHaveLength(3);
    for (const x of a) expect(x).toBeNull();
  });

  // El contraste del fixture vacío, y la evidencia de que el tipo 3 es PPM.
  it('el asistente usado trae los campos de PPM y deja los de honorarios en null', () => {
    const [t1, t2, t3] = leer('f29-complementos-asistentes-tipo3.json');

    expect(t1).toBeNull();
    expect(t2).toBeNull();
    expect(t3.scoaTipo).toBe(3);
    expect(t3.scoaRealizado).toBe('S');
    expect(t3.scoaPpmoCod563).toBeGreaterThan(0);
    // El MISMO dato es number acá y string en la propuesta: la mezcla es del SII.
    expect(typeof t3.scoaPpmoCod115).toBe('number');
    expect(t3.scoaBrutos).toBeNull();
    expect(t3.scoaRetencionEmisor).toBeNull();
  });

  it('la tasa de PPM mezcla string y number en el mismo objeto', () => {
    const t = leer('f29-tasa-ppmo.json');

    expect(typeof t.cod115).toBe('string');
    expect(typeof t.mes).toBe('number');
    expect(typeof t.anno).toBe('number');
    // Es de un período abierto: el valor es el PROPUESTO, no uno ya declarado.
    expect(t.realizado).toBe(false);
  });

  // El repositorio es público: si alguien recaptura un fixture y se olvida de
  // redactarlo, esto lo frena antes del commit.
  it('ninguno lleva datos identificatorios reales', () => {
    for (const a of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
      const crudo = fs.readFileSync(path.join(DIR, a), 'utf-8');
      expect(crudo).not.toMatch(/TRUFUL|TROVADOR/i);
      // El RUT ficticio es 11111111-1; cualquier otro RUT con DV es sospechoso.
      const ruts = crudo.match(/\b\d{7,8}-[\dkK]\b/g) ?? [];
      for (const r of ruts) expect(r).toBe('11111111-1');
    }
  });
});
