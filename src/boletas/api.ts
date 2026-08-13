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
}
