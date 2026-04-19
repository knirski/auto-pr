import { expect, test } from "bun:test";
import { PrLookupError } from "#core/errors.js";

test("PrLookupError carries branch and cause", () => {
	const e = new PrLookupError({ branch: "ai/foo", cause: "gh auth error" });
	expect(e._tag).toBe("PrLookupError");
	expect(e.branch).toBe("ai/foo");
	expect(e.cause).toBe("gh auth error");
});
