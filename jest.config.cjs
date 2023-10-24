module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 50000,
  setupFiles: ["<rootDir>/tests/setEnvVars.ts"],
  "transform": {
    "^.+\\.test.ts$": ["ts-jest", { tsconfig: "./tsconfig.tests.json" }]
  },
  testPathIgnorePatterns: ['dist/'],
}
