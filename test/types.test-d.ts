/**
 * Type tests using Vitest's expectTypeOf.
 * Run with: npm run test (--typecheck enables these).
 */

import { expectTypeOf, test } from "vitest";
import type {
	AutoPrConfigError,
	FillPrTemplateParams,
	FillPrTemplateParamsSchema,
	GhOutputValue,
	PullRequestFailedError,
} from "#auto-pr";

test("FillPrTemplateParams has required logFilePath and filesFilePath", () => {
	expectTypeOf<FillPrTemplateParams>().toHaveProperty("logFilePath").toEqualTypeOf<string>();
	expectTypeOf<FillPrTemplateParams>().toHaveProperty("filesFilePath").toEqualTypeOf<string>();
});

test("FillPrTemplateParams required templatePath and howToTestDefault", () => {
	expectTypeOf<FillPrTemplateParams>().toHaveProperty("templatePath").toEqualTypeOf<string>();
	expectTypeOf<FillPrTemplateParams>().toHaveProperty("howToTestDefault").toEqualTypeOf<string>();
});

test("FillPrTemplateParamsSchema is a Schema", () => {
	expectTypeOf<typeof FillPrTemplateParamsSchema>().toHaveProperty("ast");
});

test("GhOutputValue is branded string", () => {
	expectTypeOf<GhOutputValue>().toMatchTypeOf<string>();
	expectTypeOf<string>().not.toMatchTypeOf<GhOutputValue>();
});

test("AutoPrConfigError has missing array", () => {
	expectTypeOf<AutoPrConfigError>().toHaveProperty("missing").toExtend<readonly string[]>();
});

test("PullRequestFailedError has cause string", () => {
	expectTypeOf<PullRequestFailedError>().toHaveProperty("cause").toEqualTypeOf<string>();
});
