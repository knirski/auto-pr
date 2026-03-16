import { describe, it } from "@effect/vitest";
import { TestSchema } from "effect/testing";
import { FillPrTemplateParamsSchema } from "#auto-pr/interfaces/fill-pr-template.js";
import { Sha256HashSchema } from "#tools/update-nix-hash.js";

describe("FillPrTemplateParamsSchema", () => {
	const asserts = new TestSchema.Asserts(FillPrTemplateParamsSchema);

	it("decoding succeeds for minimal valid input", async () => {
		await asserts.decoding().succeed({
			logFilePath: "/a",
			filesFilePath: "/b",
			templatePath: "/t",
			howToTestDefault: "1. Run tests",
		});
	});

	it("decoding succeeds with optional fields", async () => {
		await asserts.decoding().succeed({
			logFilePath: "/c",
			filesFilePath: "/d",
			templatePath: "/t",
			descriptionFilePath: "/desc",
			howToTestDefault: "1. Run tests",
		});
	});

	it("decoding fails for missing required fields", async () => {
		await asserts.decoding().fail({}, 'Missing key\n  at ["logFilePath"]');
	});

	it("decoding fails for null", async () => {
		await asserts.decoding().fail(null, "Expected object, got null");
	});
});

describe("Sha256HashSchema", () => {
	const asserts = new TestSchema.Asserts(Sha256HashSchema);

	it("decoding succeeds for valid sha256- hash", async () => {
		await asserts.decoding().succeed("sha256-abcdef1234567890+/=");
	});

	it("decoding fails for invalid prefix", async () => {
		await asserts
			.decoding()
			.fail(
				"sha512-abc",
				'Expected a string matching the RegExp ^sha256-[A-Za-z0-9+/=_-]+$, got "sha512-abc"',
			);
	});

	it("decoding fails for empty string", async () => {
		await asserts
			.decoding()
			.fail("", 'Expected a string matching the RegExp ^sha256-[A-Za-z0-9+/=_-]+$, got ""');
	});
});
