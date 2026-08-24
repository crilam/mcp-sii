import { z } from 'zod';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { RecursoNoEncontrado } from '../../erroresConsulta';

// Fragmento zod compartido por las rutas REST que reciben SÓLO certificado
// digital (renta, dte, mipyme; las de BHE usan `conCredencial`, que acepta
// también clave).
//
// Se valida el alfabeto base64 ANTES de intentar decodificar: un base64 con
// basura no falla en `Buffer.from` —que decodifica "lo mejor que puede"— sino
// que escribe un .pfx corrupto y termina en un error tardío y genérico del
// scraper. Rechazarlo acá devuelve BAD_REQUEST temprano, sin gastarle cupo de
// rate-limit al tenant.
//
// El whitespace se normaliza primero, con el mismo criterio que
// `camposCredencial`: `base64` sin `-w0` corta la salida en líneas, y sin este
// saneo el mismo certificado sería válido en las rutas de BHE e inválido acá.
// Una inconsistencia así es de las peores de diagnosticar desde afuera.
export const zodCredencialCert = {
  certificado_base64: z.string().min(1)
    .transform(s => s.replace(/\s+/g, ''))
    .refine(s => /^[A-Za-z0-9+/]+={0,2}$/.test(s), 'certificado_base64 inválido'),
  certificado_password: z.string().min(1),
};

// Credencial de un request: clave tributaria O certificado digital. Las dos
// autentican y las dos producen el cookie jar que usan las consultas por HTTP
// (verificado contra el portal), así que la ruta no tiene por qué imponer una.
//
// Se aceptan las DOS en vez de migrar de certificado a clave: los tenants que ya
// mandan certificado seguirían funcionando igual, y quien custodia claves —el
// caso de Tributy, que guarda un secreto de texto por contribuyente— puede
// consumir lo mismo sin construir un flujo de certificados. Mismo criterio que
// apigateway, que expone `auth.pass` y `auth.cert`.
//
// Exactamente una: mandar las dos es un error del llamador, no algo a resolver
// con una prioridad implícita. Ya nos pasó al revés en `env.ts`, donde
// `certPath ? cert : clave` elegía sin que nadie lo pidiera y era imposible
// saber con qué se había autenticado una consulta.
const camposCredencial = {
  clave: z.string().min(1).optional(),
  // Se normaliza el whitespace ANTES de validar el alfabeto. `base64` sin `-w0`
  // (el default en BSD y GNU) corta la salida en líneas de 64 o 76 caracteres,
  // así que un `.pfx` codificado con el comando de siempre trae saltos de línea
  // y el regex a secas lo rechazaba con 400 — un certificado que funciona,
  // rechazado por el formato del volcado.
  certificado_base64: z.string().min(1)
    .transform(s => s.replace(/\s+/g, ''))
    .refine(s => /^[A-Za-z0-9+/]+={0,2}$/.test(s), 'certificado_base64 inválido')
    .optional(),
  certificado_password: z.string().min(1).optional(),
};

export type Credencial =
  | { tipo: 'clave'; clave: string }
  | { tipo: 'certificado'; base64: string; password: string };

// Envuelve el schema de una ruta agregándole la credencial y la validación de
// que venga exactamente una.
export function conCredencial<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, ...camposCredencial }).refine(
    // El cast es necesario porque con un shape genérico zod no puede probar que
    // las claves de `camposCredencial` sobreviven al merge, aunque estén ahí.
    (d: Record<string, unknown>) => {
      const conClave = Boolean(d.clave);
      // Cualquier campo de certificado cuenta como "intención de certificado",
      // no sólo el par completo. Con `clave && certificado_base64` pero sin
      // password, comparar contra el par completo daba `true !== false` → pasaba,
      // y `credencialDe` elegía la clave descartando el certificado en silencio:
      // justo la prioridad implícita que esto viene a evitar.
      const algoDeCert = Boolean(d.certificado_base64) || Boolean(d.certificado_password);
      const certCompleto = Boolean(d.certificado_base64 && d.certificado_password);
      if (conClave && algoDeCert) return false;
      return conClave || certCompleto;
    },
    {
      message: 'Mandá `clave`, o `certificado_base64` junto con ' +
        '`certificado_password`. Exactamente una de las dos, y el certificado ' +
        'con sus dos campos.',
    }
  );
}

// Traduce el body validado a la credencial que corresponde. Devolver un tipo
// discriminado, y no los campos crudos, hace que quien arma el ejecutor no pueda
// olvidarse de un caso.
export function credencialDe(d: {
  clave?: string;
  certificado_base64?: string;
  certificado_password?: string;
}): Credencial {
  if (d.clave) return { tipo: 'clave', clave: d.clave };
  return {
    tipo: 'certificado',
    base64: d.certificado_base64!,
    password: d.certificado_password!,
  };
}

export interface RespuestaRuta {
  status: number;
  body: unknown;
}

export type RutaHandler = (body: unknown) => Promise<RespuestaRuta>;

// Traduce cualquier resultado de negocio del core al contrato {ok}. Una ruta
// REST nunca debería ver SesionNoIniciada (cada request trae su propia
// `clave`, arma la sesión de cero) — si ocurriera, se trata como ERROR de
// infraestructura, no como el caso de negocio esperado que sí es en MCP.
//
// Si `resultado` es un array (varios core devuelven listas: BoletaBhe[],
// Empresa[]), NO se spreadea directo — `{ ok: true, ...[a, b] }` produce
// `{ ok: true, "0": a, "1": b }` en JSON, perdiendo la forma de lista. Se
// envuelve bajo `datos` en ese caso; los resultados que ya son objetos siguen
// spreadeándose flat, como venía haciendo cada ruta.
export async function ejecutar<R>(fn: () => Promise<R>): Promise<RespuestaRuta> {
  try {
    const resultado = await fn();
    const cuerpo = Array.isArray(resultado) ? { datos: resultado } : (resultado as object);
    return { status: 200, body: { ok: true, ...cuerpo } };
  } catch (e) {
    // NO_ENCONTRADO se resuelve acá y no dentro de clasificarErrorCredenciales:
    // ésta es la única ruta que lo necesita, y ensanchar esa función obligaba a
    // cada otro llamador (validar-clave, las tools MCP) a colapsar a mano un
    // código que nunca puede recibir. Uno se olvidaba y stringificaba el código
    // crudo.
    //
    // Importa distinguirlo: cuando el SII confirma que el dato no existe, el
    // fallo es permanente. Con el ERROR genérico, el tenant no puede separarlo
    // de una caída del portal y reintenta en loop lo que nunca va a funcionar.
    if (e instanceof RecursoNoEncontrado) {
      // Va con `detalle` porque el mensaje distingue cosas que el tenant puede
      // accionar — sobre todo "pediste una recibida como emitida", que devuelve
      // la misma respuesta del SII que un código inexistente. Es seguro
      // mandarlo: estos mensajes los redacta el scraper, no son un error crudo
      // de subproceso con el comando adentro.
      return { status: 200, body: { ok: false, error: 'NO_ENCONTRADO', detalle: e.message } };
    }
    const error = clasificarErrorCredenciales(e);
    // Un error que no es rechazo de credenciales es un bug (del scraper, de
    // infraestructura) — sin este log, queda invisible detrás del status 200.
    if (error === 'ERROR') {
      console.error('Error no clasificado en ruta REST:', e instanceof Error ? e.message : e);
    }
    return { status: 200, body: { ok: false, error } };
  }
}
