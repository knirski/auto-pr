import { describe, test } from "bun:test";
import { TestSchema } from "effect/testing";
import { FillPrTemplateParamsSchema } from "#auto-pr/interfaces/fill-pr-template.js";

describe("FillPrTemplateParamsSchema", () => {
	const asserts = new TestSchema.Asserts(FillPrTemplateParamsSchema);

	test("decoding succeeds for minimal valid input", async () => {
		await asserts.decoding().succeed({
			logFilePath: "/a",
			filesFilePath: "/b",
			templatePath: "/t",
			howToTestDefault: "1. Run tests",
		});
	});

	test("decoding succeeds with optional fields", async () => {
		await asserts.decoding().succeed({
			logFilePath: "/c",
			filesFilePath: "/d",
			templatePath: "/t",
			descriptionFilePath: "/desc",
			howToTestDefault: "1. Run tests",
		});
	});

	test("decoding fails for missing required fields", async () => {
		await asserts.decoding().fail({}, 'Missing key\n  at ["logFilePath"]');
	});

	test("decoding fails for null", async () => {
		await asserts.decoding().fail(null, "Expected object, got null");
	});
});
