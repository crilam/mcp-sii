import { CredencialesAws, HttpBoletas } from './auth';
import { firmarSigV4 } from './sigv4';

// Cliente de la API de boletas (eboleta.sii.cl), firmando SigV4 con las
// credenciales STS que produce BoletaAuth. Cubre por ahora la invocación de
// Lambda; los endpoints de API Gateway (execute-api) usan la misma firma con
// otro `service`.
//
// La app llama sus Lambdas por el endpoint de invocación directa de AWS, no por
// API Gateway. Relevado del tráfico real el 2026-08-12.

const REGION = 'us-east-1';
const LAMBDA_HOST = `https://lambda.${REGION}.amazonaws.com`;
// API Gateway de la app de boletas (el mismo host de documentos/generar). Las
// consultas /api/info-contribuyente/* y la emisión viven acá.
const API_HOST = `https://cn68i6qm0g.execute-api.${REGION}.amazonaws.com/prod`;

// Receptor genérico del SII para una boleta SIN receptor identificado —el caso
// de Parkingapp—. Relevado del request real.
const RECEPTOR_GENERICO = { RUTRecep: '66666666-6', RznSocRecep: 'SII Boleta', DirRecep: 'Santiago' };

export interface LineaBoleta {
  nombre: string;
  cantidad: number;
  // Precio total del ítem. En boleta afecta el IVA va incluido en el precio.
  precio: number;
}

export interface ReceptorBoleta {
  rut: string;
  razonSocial: string;
  direccion: string;
}

export interface EmitirBoletaParams {
  vendedor: string;          // RUT-DV de la persona que emite
  empresaRut: string;        // RUT-DV del emisor
  infoEmisor: any;           // passthrough de info-emisor-usuario (Meta.info_emisor)
  tipoDte: 39 | 41;          // 39 afecta, 41 exenta
  medioPago: number;         // id_sii del medio de pago (1 efectivo, ...)
  lineas: LineaBoleta[];
  receptor?: ReceptorBoleta; // omitido → boleta sin receptor (genérico SII)
  // El navegador manda coordenadas reales; en runtime headless se mandan las que
  // pase el llamador o 0,0. Falta confirmar que el servidor acepte 0,0.
  geolocalizacion?: { latitude: number; longitude: number };
}

export interface BoletaEmitida {
  folio: number;
  dte: any;
  pdfUrl: string;
  pdfBase64: string;
}

export class BoletaApi {
  // `ahora` se inyecta para tests deterministas; en producción es `() => new
  // Date()`. La fecha importa: SigV4 la firma y AWS rechaza firmas con demasiado
  // desfase de reloj.
  constructor(
    private http: HttpBoletas,
    private cred: CredencialesAws,
    private ahora: () => Date = () => new Date()
  ) {}

  async invocarLambda(nombreFuncion: string, payload: unknown): Promise<any> {
    const url = `${LAMBDA_HOST}/2015-03-31/functions/${nombreFuncion}/invocations`;
    const body = JSON.stringify(payload);

    const firma = firmarSigV4(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      this.cred,
      { region: REGION, service: 'lambda', fecha: this.ahora() }
    );

    const respuesta = await this.http({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...firma },
      body,
    });

    let sobre: any;
    try {
      sobre = JSON.parse(respuesta.body);
    } catch {
      throw new Error(
        `El Lambda ${nombreFuncion} no devolvió JSON (status ${respuesta.status}): ` +
        `${respuesta.body.slice(0, 150)}. La sesión pudo vencer.`
      );
    }

    // Los Lambda de eboleta responden { error, body }. Un error no-nulo es un
    // fallo de negocio: se propaga en vez de devolver un body inválido.
    if (sobre && sobre.error) {
      throw new Error(`El Lambda ${nombreFuncion} respondió con error: ${sobre.error}`);
    }
    return sobre;
  }

  // Consulta de /api/info-contribuyente/* (GET firmado a API Gateway). `ruta` es
  // la parte después de /api/info-contribuyente/, por ejemplo
  // "info-emisor-usuario/<rutEmpresa>/<rutUsuario>" o "emisores-usuario/<rut>".
  // El resultado de info-emisor-usuario se reenvía tal cual como Meta.info_emisor
  // al emitir: es un passthrough, no se arma a mano.
  async getInfoContribuyente(ruta: string): Promise<any> {
    const url = `${API_HOST}/api/info-contribuyente/${ruta}`;
    const firma = firmarSigV4(
      { method: 'GET', url, headers: {}, body: '' },
      this.cred,
      { region: REGION, service: 'execute-api', fecha: this.ahora() }
    );

    const respuesta = await this.http({ url, method: 'GET', headers: firma, body: '' });
    try {
      return JSON.parse(respuesta.body);
    } catch {
      throw new Error(
        `El endpoint ${ruta} no devolvió JSON (status ${respuesta.status}): ` +
        `${respuesta.body.slice(0, 120)}. La sesión pudo vencer.`
      );
    }
  }

  // Emite una boleta electrónica (POST firmado a documentos/generar). Es un acto
  // tributario REAL E IRREVERSIBLE: emite en un solo paso, sin previsualización.
  // El folio real lo asigna y devuelve el servidor (a diferencia del portal CGI,
  // acá viene limpio en la respuesta).
  //
  // `info_emisor` es el passthrough de getInfoContribuyente('info-emisor-usuario/
  // <empresaSinDv>/<usuario-dv>'); la sucursal (CdgSIISucur) sale de ahí.
  async emitir(params: EmitirBoletaParams): Promise<BoletaEmitida> {
    const sucursal = params.infoEmisor?.sucursales?.[0]?.codigo;
    if (!sucursal) {
      throw new Error(
        'info_emisor no trae sucursales: no se puede determinar CdgSIISucur. ' +
        'Verificá que venga de info-emisor-usuario del emisor correcto.'
      );
    }

    const receptor = params.receptor
      ? {
          RUTRecep: params.receptor.rut,
          RznSocRecep: params.receptor.razonSocial,
          DirRecep: params.receptor.direccion,
        }
      : RECEPTOR_GENERICO;

    const cuerpo = {
      vendedor: params.vendedor,
      Encabezado: {
        // El Folio del request es un placeholder: el servidor asigna el real y
        // lo devuelve en la respuesta.
        IdDoc: { TipoDTE: params.tipoDte, Folio: 1, MedioPago: params.medioPago },
        Emisor: { RUTEmisor: params.empresaRut, CdgSIISucur: sucursal },
        Receptor: receptor,
      },
      Detalle: params.lineas.map(l => ({
        NmbItem: l.nombre,
        QtyItem: l.cantidad,
        PrcItem: l.precio,
      })),
      Meta: {
        info_emisor: params.infoEmisor,
        geolocalizacion: params.geolocalizacion ?? { latitude: 0, longitude: 0 },
        plataforma: 'eboleta_web',
      },
    };

    const url = `${API_HOST}/api/dte/documentos/generar`;
    const body = JSON.stringify(cuerpo);
    const firma = firmarSigV4(
      // El content-type real del portal es form-urlencoded aunque el body sea
      // JSON; como no se firma, se replica por fidelidad.
      { method: 'POST', url, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      this.cred,
      { region: REGION, service: 'execute-api', fecha: this.ahora() }
    );

    const respuesta = await this.http({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...firma },
      body,
    });

    let r: any;
    try {
      r = JSON.parse(respuesta.body);
    } catch {
      throw new Error(
        `documentos/generar no devolvió JSON (status ${respuesta.status}): ` +
        `${respuesta.body.slice(0, 150)}. NO se sabe si se emitió: revisá el historial.`
      );
    }
    if (!r || typeof r.folio !== 'number') {
      throw new Error(
        `documentos/generar no devolvió un folio. Respuesta: ${JSON.stringify(r).slice(0, 150)}.`
      );
    }
    return { folio: r.folio, dte: r.dte, pdfUrl: r.pdf_public_url, pdfBase64: r.b64encoded_pdf };
  }
}
