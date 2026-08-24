// Config aparte para las pruebas contra el SII real (`npm run test:e2e`).
//
// Van separadas de la suite normal a propósito: cada test abre una sesión de
// verdad en el portal, el SII limita las sesiones simultáneas por RUT y bloquea
// claves con varios intentos fallidos. Meterlas en `npm test` haría que
// cualquiera que corra los tests —o un CI— golpee el portal con credenciales
// reales sin querer.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/e2e'],
  moduleFileExtensions: ['ts', 'js'],
  // En serie, sin excepción: dos logins simultáneos del mismo RUT es justo lo
  // que el SII bloquea (error 01.01.190.500.720.27).
  maxWorkers: 1,
  // Carga SII_RUT/SII_CLAVE del .env, igual que los scripts del proyecto.
  setupFiles: ['dotenv/config'],
};
