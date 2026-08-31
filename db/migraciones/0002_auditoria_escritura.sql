-- Ronda 11 (escritura de portal): la traza de auditoría necesita distinguir un
-- acto real de una simulación (dry-run), y guardar el identificador del acto
-- (folio emitido, folio anulado, evento acusado). La tabla `auditoria` ya
-- registra cada request (tenant, ruta, status); estas dos columnas la vuelven
-- útil para responder "¿qué se escribió, cuándo y con qué resultado?".
--
-- Ambas nullable: las rutas de LECTURA no las llenan, y quedan NULL sin cambiar
-- su comportamiento.
ALTER TABLE auditoria
  ADD COLUMN efecto     text CHECK (efecto IN ('simulado', 'ejecutado', 'fallido')),
  ADD COLUMN referencia text;  -- id del acto: folio, código, evento; NULL si no aplica

-- 'simulado' = dry-run; 'ejecutado' = acto cursado; 'fallido' = confirmar:true
-- que no cursó (rechazo del SII, error, o bloqueo de la red anti-doble-click,
-- que ni siquiera tocó el SII). NULL en lecturas.
