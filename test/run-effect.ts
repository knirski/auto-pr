/**
 * Run Effect with layer. Replaces @effect/vitest it.effect without adapter.
 * Based on effect packages/vitest/src/internal/internal.ts
 *
 * Curried: runEffect(layer)(effect) — layer type is inferred first.
 */
import { Effect, type Layer } from "effect";

export function runEffect<R, EL>(
  layer: Layer.Layer<R, EL>,
): <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A> {
  return (effect) => Effect.runPromise(Effect.provide(effect.pipe(Effect.scoped), layer));
}
