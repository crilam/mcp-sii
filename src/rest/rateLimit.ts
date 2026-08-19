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

export async function chequearRateLimitIp(
  pool: Pool,
  ip: string,
  limitePorMinuto: number
): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO auth_fallida_contador (ip, ventana_inicio, contador)
     VALUES ($1, $2, 1)
     ON CONFLICT (ip, ventana_inicio)
     DO UPDATE SET contador = auth_fallida_contador.contador + 1
     RETURNING contador`,
    [ip, ventanaActual()]
  );
  return rows[0].contador <= limitePorMinuto;
}
