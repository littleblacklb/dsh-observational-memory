/**
 * The memory block the model reads during a session.
 *
 * Compaction renders memory when the window fills, but a long stretch of work
 * can pass between compactions, and during that stretch the model is holding
 * whatever memory the last checkpoint carried. This module contributes the
 * current fold as runtime context, so what the model knows about earlier work
 * tracks the ledger rather than only the last compaction.
 *
 * The contribution is a context rather than a section: the loop materializes it
 * as a logged user-role snapshot after retained history, deduplicated by exact
 * text, so unchanged memory adds nothing to the request and leaves the provider's
 * cached prefix intact.
 *
 * @module @deepseek-ai/dsh-observational-memory/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Observation, Reflection } from './vocabulary.ts'
import type { ObservationalMemoryState } from './vocabulary.ts'
import { renderMemory } from './render.ts'

/** Name of the registered context contribution. */
export const MEMORY_CONTEXT_NAME = 'observational-memory'

/**
 * Prompt-context order for the memory block.
 *
 * Placed late so memory reads after the standing runtime context a deployment
 * owns, and before the harness's own trailing material.
 */
export const MEMORY_CONTEXT_ORDER = 300

/** The assembly context as the loop passes it, including the agent it adds. */
interface AgentAssemblyContext {
  readonly agent?: Agent
}

/**
 * Read the folded memory a contribution should render.
 *
 * This plugin registers the projection on its own fiber, so the registry always
 * holds a state for a session it owns; there is no unregistered case to fall
 * back from.
 * @param ctx - context carrying the projection registry.
 * @param agent - the agent whose session the assembly belongs to.
 * @returns the folded memory state.
 */
function memoryFor(ctx: Context, agent: Agent): ObservationalMemoryState {
  return ctx.sessionProjections.stateOf(agent.session, 'observationalMemory') as ObservationalMemoryState
}

/**
 * Render the memory block for one assembly.
 *
 * Returns an empty string when there is nothing to show, which the assembly
 * treats as no contribution at all. The text is a pure function of the folded
 * state, so it is byte-identical between assemblies until memory changes: that
 * is what makes the snapshot deduplicable and the request prefix cacheable.
 * @param ctx - context carrying the projection registry.
 * @param agent - the agent whose session the assembly belongs to.
 * @returns the rendered block, or an empty string when memory is empty.
 */
export function renderMemoryContext(ctx: Context, agent: Agent | undefined): string {
  if (agent === undefined) return ''
  const state = memoryFor(ctx, agent)
  return renderMemory(state.reflections as Reflection[], state.observations as Observation[])
}

/**
 * Register the memory context contribution.
 *
 * The provider runs per assembly and reads the projection at that moment, so a
 * consolidation that lands mid-turn is reflected on the next request without any
 * subscription of its own. Registration is effect-scoped: unloading the plugin
 * removes the contribution with the rest of its registrations.
 * @param ctx - context carrying the system prompt registry and the projections.
 * @returns the registration disposer.
 */
export function registerMemoryContext(ctx: Context): () => void {
  return ctx.systemPrompt.context({
    name: MEMORY_CONTEXT_NAME,
    order: MEMORY_CONTEXT_ORDER,
    text: (assembly: unknown): string =>
      renderMemoryContext(ctx, (assembly as AgentAssemblyContext | undefined)?.agent),
  })
}
