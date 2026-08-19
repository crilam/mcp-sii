import { Pool } from 'pg';

// Ventana fija de un minuto: trunca el timestamp actual al minuto y usa eso
// como parte de la clave primaria. Simple de razonar; alcanza para el caso de
// uso (evitar que un consumidor sature el servicio), no hace falta ventana
// deslizante.
function ventanaActual(): Date {
  const ahora = new Date();
  ahora.setSeconds(0, 0);
  return ahora;
}

export async function chequearRateLimitTenant(
  pool: Pool,
  tenantId: string,
  limitePorMinuto: number
): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO rate_limit_contador (tenant_id, ventana_inicio, contador)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, ventana_inicio)
     DO UPDATE SET contador = rate_limit_contador.contador + 1
     RETURNING contador`,
    [tenantId, ventanaActual()]
  );
  return rows[0].contador <= limitePorMinuto;
}

// Sólo LEE el contador de fallos de auth de esta IP en la ventana actual —no
// lo incrementa—. Se usa antes de intentar autenticar: si la IP ya superó el
// límite por fallos PREVIOS, se corta sin ni siquiera intentar la auth nueva.
// Un request que autentica bien nunca debe sumar acá (ver registrarFalloIp).
export async function contadorFallosIp(pool: Pool, ip: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT contador FROM auth_fallida_contador WHERE ip = $1 AND ventana_inicio = $2`,
    [ip, ventanaActual()]
  );
  return rows[0]?.contador ?? 0;
}

// Incrementa el contador de fallos de auth de esta IP. Sólo se llama cuando
// la autenticación efectivamente FALLÓ — nunca en el camino de éxito, o un
// tenant legítimo detrás de la misma IP terminaría limitado por su propio
// tráfico bueno en vez de por intentos fallidos ajenos.
export async function registrarFalloIp(pool: Pool, ip: string): Promise<void> {
  await pool.query(
    `INSERT INTO auth_fallida_contador (ip, ventana_inicio, contador)
     VALUES ($1, $2, 1)
     ON CONFLICT (ip, ventana_inicio)
     DO UPDATE SET contador = auth_fallida_contador.contador + 1`,
    [ip, ventanaActual()]
  );
}
