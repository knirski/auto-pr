/**
 * Parse `gh pr create` stdout into a validated GitHub PR URL.
 * Uses regex instead of `Url.fromString` from Effect: that helper is oriented to
 * `import.meta.url`-style resolution in this repo, not arbitrary http(s) PR links.
 */

import { Result } from "effect";
import { PullRequestUrlParseError } from "./errors.js";

/** GitHub-style PR URL: `https(s)://host/<org>/<repo>/pull/<digits>` (no extra path segments). */
const GH_PR_URL = /^https?:\/\/[^/?#\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u;

/** Pure: extract the PR URL from `gh pr create` stdout. Validates shape. */
export function parseGhPrCreateOutput(
	stdout: string,
): Result.Result<string, PullRequestUrlParseError> {
	const lines = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const last = lines.at(-1);
	if (last === undefined) {
		return Result.fail(new PullRequestUrlParseError({ raw: stdout, reason: "empty output" }));
	}
	if (!GH_PR_URL.test(last)) {
		return Result.fail(
			new PullRequestUrlParseError({ raw: stdout, reason: `last line is not a PR URL: ${last}` }),
		);
	}
	return Result.succeed(last);
}
