module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // Las pruebas contra el SII real viven en tests/e2e y tienen su propio
  // comando (`npm run test:e2e`): abren sesiones de verdad en el portal, que
  // limita las simultáneas por RUT y bloquea claves con intentos fallidos. No
  // deben dispararse por correr `npm test` ni en CI.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/e2e/'],
  moduleFileExtensions: ['ts', 'js'],
  // Los tests de infra REST/Neon comparten una única base de test (sin
  // WHERE por archivo en los DELETE de limpieza) — correr en paralelo hace
  // que un archivo borre filas que otro insertó a mitad de su test. La suite
  // es rápida (segundos), así que correr en serie no cuesta nada real.
  maxWorkers: 1,
};
