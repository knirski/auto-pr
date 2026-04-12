/**
 * Integration pins come only from the environment: `bun run test:integration` loads `.env.ci`, then
 * optional `.env.local` (overrides, same pattern as Vite/Next). GitHub Actions loads `.env.ci` into the job env.
 * Do not duplicate URLs or model ids in test source.
 */
export function requireIntegrationEnv(name: string): string {
	const v = process.env[name]?.trim();
	if (v === undefined || v === "") {
		throw new Error(
			`${name} is not set. Ensure .env.ci is loaded (bun run test:integration) or export vars; optional overrides: .env.local; CI uses .env.ci.`,
		);
	}
	return v;
}
