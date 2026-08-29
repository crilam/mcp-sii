import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { pausaConfigurada } from '../ritmoSii';

// Verificación de un DTE contra el SII: si fue recibido (validez) y si los datos
// que uno tiene coinciden con los que el emisor informó (contenido).
//
// Eran consultas públicas y el SII las puso detrás del login: las dos redirigen
// a IngresoRutClave sin sesión. Con sesión sirven dos CGI legacy de palena:
//
//   GET  DTEauth?2  → formulario  → POST QValidaDTE  (validez)
//   GET  DTEauth?6  → formulario  → POST QEstadoDTE  (contenido)
//
// El GET del formulario NO es decorativo: deja la sesión del CGI armada. Los
// nombres de los campos son los del formulario, incluidos los ocultos con el
// RUT de quien consulta (`rutConsulta`/`rutQuery`), que el CGI exige.
//
// La respuesta es HTML con el resultado en texto; el parser lo lee por FORMA
// (etiquetas y orden), y falla explícito si la página no trae un resultado,
// porque una respuesta vacía no es "documento inválido".
const BASE = 'https://palena.sii.cl/cgi_dte/UPL';

export interface DteAVerificar {
  rutEmisor: string;
  tipoDte: number;
  folio: number;
}

export interface DteAVerificarContenido extends DteAVerificar {
  rutReceptor: string;
  // YYYY-MM-DD
  fechaEmision: string;
  montoTotal: number;
}

export interface ResultadoValidez {
  recibidoPorElSii: boolean;
  resultado: string;
  emisorNombre: string;
  identificadorEnvio: string | null;
  rutEmisor: string;
  tipoDteNombre: string;
  // null si la página no trajo el folio: un 0 se leería como "folio cero".
  folio: number | null;
  comprobante: string | null;
}

export interface ResultadoContenido extends ResultadoValidez {
  datosCoinciden: boolean;
  fechaEmision: string | null;
  rutReceptor: string | null;
  montoTotal: number | null;
}

const ENTIDADES: Record<string, string> = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', nbsp: ' ', amp: '&',
};

// La página se reduce a sus TEXTOS, en orden: es lo único estable de un CGI de
// esta edad. Las celdas vacías y los espacios duros desaparecen.
export function textosDe(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .split(/<[^>]+>/)
    .map(t => t.replace(/&([a-zA-Z]+);/g, (m, e) => ENTIDADES[e] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/\s+/g, ' ').trim())
    .filter(t => t !== '' && t !== ':' && t !== '-');
}

function despuesDe(textos: string[], etiqueta: RegExp): string | null {
  const i = textos.findIndex(t => etiqueta.test(t));
  return i === -1 || i + 1 >= textos.length ? null : textos[i + 1];
}

function parsearComun(html: string, que: string): ResultadoValidez {
  const textos = textosDe(html);
  const resultado = despuesDe(textos, /^Resultado de la Consulta:?$/i);
  if (!resultado) {
    // Sin resultado no hay veredicto: puede ser el login, un error del CGI o un
    // rediseño. Decirlo evita que se lea como "documento inválido".
    throw new Error(
      `El SII no devolvió un resultado al ${que} el DTE. La sesión pudo expirar o el `
      + `formulario cambió. Texto: ${textos.slice(0, 8).join(' | ').slice(0, 200)}`);
  }
  const iDoc = textos.findIndex(t => /^Documento consultado:?$/i.test(t));
  const bloque = iDoc === -1 ? [] : textos.slice(iDoc + 1, iDoc + 6);
  const emisorNombre = bloque[0] && !/^Identificador|^R\.U\.T\./i.test(bloque[0]) ? bloque[0] : '';
  const envio = bloque.find(t => /^Identificador de Env[ií]o:/i.test(t));
  const rut = bloque.find(t => /^R\.U\.T\.?/i.test(t));
  // El tipo se busca DESPUÉS del RUT, nunca en el nombre del emisor: una razón
  // social como "FACTURA Y COBRANZA SPA" también dice "Factura".
  const iRut = rut ? bloque.indexOf(rut) : -1;
  const trasRut = iRut === -1 ? bloque.slice(1) : bloque.slice(iRut + 1);
  const tipo = trasRut.find(t => /Electr[oó]nica|Factura|Nota|Gu[ií]a|Liquidaci[oó]n|Boleta/i.test(t)) ?? '';
  const folioTxt = trasRut.find(t => /^N[°º]\s*\d+/.test(t)) ?? '';
  const comprobante = despuesDe(textos, /^Comprobante de Atenci[oó]n$/i);

  return {
    recibidoPorElSii: /recibido por el SII/i.test(resultado),
    resultado,
    emisorNombre,
    identificadorEnvio: envio ? envio.replace(/^Identificador de Env[ií]o:\s*/i, '') : null,
    rutEmisor: rut ? rut.replace(/^R\.U\.T\.?\s*/i, '') : '',
    tipoDteNombre: tipo,
    folio: folioTxt ? Number(folioTxt.replace(/\D/g, '')) : null,
    comprobante: comprobante ? comprobante.replace(/\s+/g, ' ') : null,
  };
}

export function parsearValidez(html: string): ResultadoValidez {
  return parsearComun(html, 'consultar la validez de');
}

export function parsearContenido(html: string): ResultadoContenido {
  const base = parsearComun(html, 'verificar el contenido de');
  const textos = textosDe(html);
  // Las tres etiquetas van seguidas y después los tres valores, en el mismo
  // orden: "Fecha Emisión: | Rut Receptor: | Monto Total: | 31-07-2025 |
  // 11111111-1 | $ 68.366".
  const iFecha = textos.findIndex(t => /^Fecha Emisi[oó]n:?$/i.test(t));
  const valores = iFecha === -1 ? [] : textos.slice(iFecha + 3, iFecha + 6);
  // Cada valor se valida por FORMA: si el layout corriera una posición, una
  // etiqueta ("Rut Receptor:") caería en el lugar de un valor, y devolverla tal
  // cual sería publicar texto arbitrario como dato. Lo que no tiene la forma
  // esperada va en null.
  const m = valores[0] ? /^(\d{2})-(\d{2})-(\d{4})$/.exec(valores[0]) : null;
  const rutReceptor = valores[1] && /^\d{1,8}-[\dkK]$/.test(valores[1]) ? valores[1] : null;
  const monto = valores[2] && /^\$?\s*[\d.]+$/.test(valores[2]) ? Number(valores[2].replace(/[^\d]/g, '')) : null;
  return {
    ...base,
    // "Datos coinciden con los registrados" contra "datos NO coinciden con los
    // registrados": un `includes('coinciden')` daría verdadero en los dos. Medido
    // con el mismo documento y el monto cambiado en un peso. El "NO" del SII va
    // en mayúsculas y así se busca; si algún día lo escriben en minúscula, el
    // texto sigue en `resultado` para leerlo.
    datosCoinciden: /coinciden con los registrados/i.test(base.resultado)
      && !/\bNO coinciden/.test(base.resultado),
    fechaEmision: m ? `${m[3]}-${m[2]}-${m[1]}` : null,
    rutReceptor,
    montoTotal: monto === null || Number.isNaN(monto) ? null : monto,
  };
}

function partir(rut: string): { cuerpo: string; dv: string } {
  const limpio = rut.replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{1,8})-?([\dK])$/.exec(limpio);
  if (!m) throw new Error(`El RUT "${rut}" no tiene la forma NNNNNNNN-D.`);
  return { cuerpo: m[1], dv: m[2] };
}

export class DteVerificacionScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  async validez(d: DteAVerificar): Promise<ResultadoValidez> {
    this.session.assertPuedeEntregarCookieJar();
    const yo = this.session.identidad();
    const emisor = partir(d.rutEmisor);
    await this.http.get(`${BASE}/DTEauth?2`, undefined, { guardarCookies: true });
    // Dos pedidos seguidos al mismo CGI: con el ritmo de siempre.
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const html = await this.http.postForm(`${BASE}/QValidaDTE`, {
      rutConsulta: yo.rut, dvConsulta: yo.dv,
      rutQuery: emisor.cuerpo, dvQuery: emisor.dv,
      tipoDTE: String(d.tipoDte), folioDTE: String(d.folio),
    }, { charset: 'latin1' });
    return parsearValidez(html);
  }

  async contenido(d: DteAVerificarContenido): Promise<ResultadoContenido> {
    this.session.assertPuedeEntregarCookieJar();
    const yo = this.session.identidad();
    const emisor = partir(d.rutEmisor);
    const receptor = partir(d.rutReceptor);
    const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.fechaEmision);
    if (!f) throw new Error(`La fecha de emisión tiene que ser YYYY-MM-DD; se recibió "${d.fechaEmision}".`);
    await this.http.get(`${BASE}/DTEauth?6`, undefined, { guardarCookies: true });
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const html = await this.http.postForm(`${BASE}/QEstadoDTE`, {
      rutQuery: yo.rut, dvQuery: yo.dv,
      rutCompany: emisor.cuerpo, dvCompany: emisor.dv,
      rutReceiver: receptor.cuerpo, dvReceiver: receptor.dv,
      tipoDTE: String(d.tipoDte), folioDTE: String(d.folio),
      // El formulario pide ddmmaaaa sin separadores.
      fechaDTE: `${f[3]}${f[2]}${f[1]}`,
      montoDTE: String(Math.round(d.montoTotal)),
    }, { charset: 'latin1' });
    return parsearContenido(html);
  }
}
