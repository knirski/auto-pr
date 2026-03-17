/**
 * Preload for bun test. Runs before any tests.
 * Use for global mocks, env setup, or beforeAll/afterAll.
 */
// Ensure test environment
if (process.env.NODE_ENV === undefined) {
	process.env.NODE_ENV = "test";
}
