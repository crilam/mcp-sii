import { recorrerConRitmo, pausaConfigurada, tercerNivelHabilitado } from '../src/ritmoSii';

// El ritmo existe porque el SII bloquea a los scrapers: un barrido de más de
// doscientas llamadas en pocos minutos dejó el portal del RCV respondiendo error
// a todo. Estos tests fijan las tres garantías que hacen que un barrido pase
// desapercibido, para que nadie las "optimice" sin saber qué sostienen.

describe('recorrerConRitmo', () => {
  afterEach(() => { delete process.env.RITMO_SII_MS; });

  // En serie y no en paralelo: un puñado de requests concurrentes es la firma
  // que delata a un scraper, y además el SII limita las sesiones simultáneas
  // por RUT.
  it('llama en serie, nunca en paralelo', async () => {
    let enVuelo = 0;
    let maximoSimultaneo = 0;

    await recorrerConRitmo([1, 2, 3, 4], async () => {
      enVuelo++;
      maximoSimultaneo = Math.max(maximoSimultaneo, enVuelo);
      await new Promise(r => setImmediate(r));
      enVuelo--;
    }, { pausaMs: 0 });

    expect(maximoSimultaneo).toBe(1);
  });

  // El tope corta la combinatoria. Una anidación de métodos por tipos por
  // períodos crece rapidísimo y es fácil escribir cien llamadas sin notarlo.
  it('corta en el tope y AVISA que lo hizo', async () => {
    const llamados: number[] = [];
    const avisos: string[] = [];

    await recorrerConRitmo([1, 2, 3, 4, 5], async n => { llamados.push(n); },
      { pausaMs: 0, tope: 2, avisar: m => avisos.push(m) });

    expect(llamados).toEqual([1, 2]);
    // El aviso importa tanto como el corte: un barrido truncado en silencio se
    // lee como "no hay datos" cuando en realidad no se llegó a mirar.
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/no se miró NO es "sin datos"/);
  });

  it('no avisa cuando el barrido entra en el tope', async () => {
    const avisos: string[] = [];

    await recorrerConRitmo([1, 2], async () => {}, { pausaMs: 0, tope: 5, avisar: m => avisos.push(m) });

    expect(avisos).toEqual([]);
  });

  it('devuelve los resultados en orden', async () => {
    const r = await recorrerConRitmo([1, 2, 3], async n => n * 10, { pausaMs: 0 });
    expect(r).toEqual([10, 20, 30]);
  });

  // La pausa va entre llamadas, no antes de la primera: si fuera antes, cada
  // barrido pagaría una espera de arranque que no protege de nada.
  it('espera entre llamadas y no antes de la primera', async () => {
    jest.useFakeTimers();
    const momentos: number[] = [];

    const corriendo = recorrerConRitmo([1, 2, 3], async () => {
      momentos.push(Date.now());
    }, { pausaMs: 1000 });

    // Con timers falsos hay que dejar correr las microtareas entre avances.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
    }
    await corriendo;

    expect(momentos).toHaveLength(3);
    // Las diferencias entre llamadas son de la pausa; la primera no espera.
    expect(momentos[1] - momentos[0]).toBeGreaterThanOrEqual(1000);
    expect(momentos[2] - momentos[1]).toBeGreaterThanOrEqual(1000);
    jest.useRealTimers();
  });
});

describe('pausaConfigurada', () => {
  afterEach(() => { delete process.env.RITMO_SII_MS; });

  it('usa un valor por defecto conservador', () => {
    expect(pausaConfigurada()).toBeGreaterThanOrEqual(1000);
  });

  it('respeta RITMO_SII_MS para poder ir MÁS lento', () => {
    process.env.RITMO_SII_MS = '3000';
    expect(pausaConfigurada()).toBe(3000);
  });

  // Las tres formas de quedarse sin pausa, que es lo único que este módulo no
  // puede permitir: las tres fallan en silencio y el síntoma aparece recién como
  // portal bloqueado.
  it('un valor basura vuelve al defecto', () => {
    process.env.RITMO_SII_MS = 'rapido';
    expect(pausaConfigurada()).toBe(1200);
  });

  // `Number("")` es 0, NO NaN: una variable definida y vacía —de lo más común en
  // un deploy— pasaba un guard que sólo mirara isFinite y dejaba el barrido a
  // toda velocidad.
  it('una variable vacía vuelve al defecto y no deja el barrido sin pausa', () => {
    process.env.RITMO_SII_MS = '';
    expect(pausaConfigurada()).toBe(1200);
    process.env.RITMO_SII_MS = '   ';
    expect(pausaConfigurada()).toBe(1200);
  });

  // El defecto es un PISO: no se puede bajar ni queriendo.
  it('no permite bajar la pausa por debajo del defecto', () => {
    process.env.RITMO_SII_MS = '0';
    expect(pausaConfigurada()).toBe(1200);
    process.env.RITMO_SII_MS = '50';
    expect(pausaConfigurada()).toBe(1200);
  });
});

// El tercer nivel de troceo del respaldo XML combina tipo_dte con
// folio/contraparte. Folio ya se verificó contra el SII real; contraparte
// todavía no. Por eso cada eje tiene SU PROPIA variable —para poder prender
// el verificado sin prender el no verificado—, las dos apagadas por defecto,
// más el flag heredado `RESPALDO_XML_TERCER_NIVEL` que sigue prendiendo los
// dos ejes a la vez (compatibilidad), con las variables por eje teniendo
// PRECEDENCIA sobre él.
describe('tercerNivelHabilitado', () => {
  afterEach(() => {
    delete process.env.RESPALDO_XML_TERCER_NIVEL;
    delete process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO;
    delete process.env.RESPALDO_XML_TERCER_NIVEL_CONTRAPARTE;
  });

  it('está apagado por defecto en los dos ejes (sin ninguna variable definida)', () => {
    expect(tercerNivelHabilitado('folio')).toBe(false);
    expect(tercerNivelHabilitado('contraparte')).toBe(false);
  });

  it('RESPALDO_XML_TERCER_NIVEL_FOLIO prende SÓLO el eje de folio', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO = '1';
    expect(tercerNivelHabilitado('folio')).toBe(true);
    expect(tercerNivelHabilitado('contraparte')).toBe(false);
  });

  it('RESPALDO_XML_TERCER_NIVEL_CONTRAPARTE prende SÓLO el eje de contraparte', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL_CONTRAPARTE = '1';
    expect(tercerNivelHabilitado('contraparte')).toBe(true);
    expect(tercerNivelHabilitado('folio')).toBe(false);
  });

  it('"true", sin importar mayúsculas, también activa cada variable por eje', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO = 'TRUE';
    expect(tercerNivelHabilitado('folio')).toBe(true);
    process.env.RESPALDO_XML_TERCER_NIVEL_CONTRAPARTE = 'True';
    expect(tercerNivelHabilitado('contraparte')).toBe(true);
  });

  it('cualquier otro valor en la variable por eje la deja apagada', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO = '0';
    expect(tercerNivelHabilitado('folio')).toBe(false);
    process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO = 'si';
    expect(tercerNivelHabilitado('folio')).toBe(false);
  });

  // El flag heredado existe desde antes de partir el interruptor: sigue
  // funcionando igual que siempre, prendiendo los DOS ejes a la vez, para no
  // romper a quien ya lo tiene puesto en algún ambiente.
  it('el flag heredado RESPALDO_XML_TERCER_NIVEL prende los DOS ejes', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '1';
    expect(tercerNivelHabilitado('folio')).toBe(true);
    expect(tercerNivelHabilitado('contraparte')).toBe(true);
  });

  it('el flag heredado también acepta "true" sin importar mayúsculas', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = 'TRUE';
    expect(tercerNivelHabilitado('folio')).toBe(true);
    expect(tercerNivelHabilitado('contraparte')).toBe(true);
  });

  it('el flag heredado con cualquier otro valor deja los dos ejes apagados', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '0';
    expect(tercerNivelHabilitado('folio')).toBe(false);
    expect(tercerNivelHabilitado('contraparte')).toBe(false);
    process.env.RESPALDO_XML_TERCER_NIVEL = 'si';
    expect(tercerNivelHabilitado('folio')).toBe(false);
    expect(tercerNivelHabilitado('contraparte')).toBe(false);
  });

  // Precedencia: la variable por eje manda sobre el flag heredado, en las dos
  // direcciones (apaga lo que el heredado prendía, y prende lo que el
  // heredado dejaba apagado).
  it('la variable por eje tiene PRECEDENCIA sobre el flag heredado: lo apaga', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '1';
    process.env.RESPALDO_XML_TERCER_NIVEL_CONTRAPARTE = '0';
    expect(tercerNivelHabilitado('contraparte')).toBe(false);
    // El otro eje, sin variable propia, sigue gobernado por el heredado.
    expect(tercerNivelHabilitado('folio')).toBe(true);
  });

  it('la variable por eje tiene PRECEDENCIA sobre el flag heredado: lo prende', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '0';
    process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO = '1';
    expect(tercerNivelHabilitado('folio')).toBe(true);
    expect(tercerNivelHabilitado('contraparte')).toBe(false);
  });

  // Coexistencia parcial: el escenario real de una transición, con el
  // heredado prendido de antes y sólo UN eje con variable propia. Folio la
  // tiene puesta (y en un valor que CONTRADICE al heredado, para que la
  // precedencia se note); contraparte no tiene variable propia y por eso
  // sigue el heredado. Las dos lecturas conviven en la misma corrida.
  it('coexistencia parcial: heredado prendido, folio con su propia variable (apagándolo), contraparte sin variable propia (sigue el heredado)', () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '1';
    process.env.RESPALDO_XML_TERCER_NIVEL_FOLIO = '0';
    expect(tercerNivelHabilitado('folio')).toBe(false);
    expect(tercerNivelHabilitado('contraparte')).toBe(true);
  });
});
