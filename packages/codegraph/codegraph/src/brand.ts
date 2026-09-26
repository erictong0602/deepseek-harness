/**
 * dsh-codegraph's owned branded id: {@link CodeGraphProviderId}, the opaque identity a provider
 * reserves on `ctx.codeGraph`. The `Branded<B>` primitive lives in `@deepseek-ai/dsh-brand`; keeping
 * the type and its factory together here lets `index.ts` re-export both under one name.
 * @module @deepseek-ai/dsh-codegraph/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque provider identity, reserved by the sole registry slot at registration. */
export type CodeGraphProviderId = Branded<'CodeGraphProviderId'>

/**
 * Brand a string as a {@link CodeGraphProviderId}. No validation — the registry rejects an empty id
 * at registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function CodeGraphProviderId(id: string): CodeGraphProviderId {
  return id as CodeGraphProviderId
}
