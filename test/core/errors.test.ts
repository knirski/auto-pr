import { expect, test } from "bun:test";
import { PullRequestLookupError, PullRequestUrlParseError } from "#core/errors.js";

test("PullRequestLookupError carries branch and cause", () => {
	const e = new PullRequestLookupError({ branch: "ai/foo", cause: "gh auth error" });
	expect(e._tag).toBe("PullRequestLookupError");
	expect(e.branch).toBe("ai/foo");
	expect(e.cause).toBe("gh auth error");
});

test("PullRequestUrlParseError carries raw and reason", () => {
	const e = new PullRequestUrlParseError({ raw: "garbage", reason: "not a URL" });
	expect(e._tag).toBe("PullRequestUrlParseError");
	expect(e.raw).toBe("garbage");
	expect(e.reason).toBe("not a URL");
});
