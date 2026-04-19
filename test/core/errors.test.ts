import { expect, test } from "bun:test";
import { PrLookupError, PrUrlParseError } from "#core/errors.js";

test("PrLookupError carries branch and cause", () => {
	const e = new PrLookupError({ branch: "ai/foo", cause: "gh auth error" });
	expect(e._tag).toBe("PrLookupError");
	expect(e.branch).toBe("ai/foo");
	expect(e.cause).toBe("gh auth error");
});

test("PrUrlParseError carries raw and reason", () => {
	const e = new PrUrlParseError({ raw: "garbage", reason: "not a URL" });
	expect(e._tag).toBe("PrUrlParseError");
	expect(e.raw).toBe("garbage");
	expect(e.reason).toBe("not a URL");
});
