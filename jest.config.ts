module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js'],
  // Los tests de infra REST/Neon comparten una única base de test (sin
  // WHERE por archivo en los DELETE de limpieza) — correr en paralelo hace
  // que un archivo borre filas que otro insertó a mitad de su test. La suite
  // es rápida (segundos), así que correr en serie no cuesta nada real.
  maxWorkers: 1,
};
