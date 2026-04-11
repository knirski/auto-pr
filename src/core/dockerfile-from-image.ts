/**
 * Pure: extract the Docker image ref from the first `FROM` line in a Dockerfile fragment.
 * Used by integration tests; CI uses read-dockerfile-image.sh — keep in sync (see test/core/dockerfile-from-image.test.ts).
 */

import { Result } from "effect";

/** First FROM line: optional `--` flags, then image ref (aligned with read-dockerfile-image.sh). */
const FROM_IMAGE_REGEX = /^FROM\s+(?:(?:--[a-zA-Z0-9_-]+(?:=\S+)?)\s+)*(\S+)/i;

/**
 * Returns the first image reference after `FROM` (case-insensitive), skipping full-line `#` comments.
 * Does not support line continuation (`\\` + newline) or multi-stage selection beyond “first FROM”.
 */
export function parseFirstFromImageDockerfileContent(
	content: string,
): Result.Result<string, string> {
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("#")) {
			continue;
		}
		const m = trimmed.match(FROM_IMAGE_REGEX);
		if (m?.[1] !== undefined) {
			const image = m[1];
			return image.length > 0 ? Result.succeed(image) : Result.fail("FROM image must be non-empty");
		}
	}
	return Result.fail("No usable FROM line in Dockerfile");
}
