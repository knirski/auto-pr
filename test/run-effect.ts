/**
 * Run Effect with layer. Replaces @effect/vitest it.effect without adapter.
 * Based on effect-smol packages/vitest/src/internal/internal.ts
 */
import { Effect, type Layer } from "effect";

export async function runEffect<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	layer: Layer.Layer<R, E>,
): Promise<A> {
	return Effect.runPromise(Effect.provide(effect.pipe(Effect.scoped), layer));
}
