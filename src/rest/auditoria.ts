import { Pool } from 'pg';

export interface EntradaAuditoria {
  tenantId: string | null;
  ip: string;
  rut: string | null;
  ruta: string;
  status: number;
  error: string | null;
}

// Nunca lanza: un fallo al auditar no debe romper ni atrasar la respuesta al
// cliente (ver spec, sección Auditoría). Se loguea a stderr para no perder la
// visibilidad del fallo, pero el caller no tiene que manejar una excepción acá.
export async function registrarAuditoria(pool: Pool, entrada: EntradaAuditoria): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO auditoria (tenant_id, ip, rut, ruta, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entrada.tenantId, entrada.ip, entrada.rut, entrada.ruta, entrada.status, entrada.error]
    );
  } catch (e) {
    console.error('No se pudo escribir en auditoria:', e);
  }
}
