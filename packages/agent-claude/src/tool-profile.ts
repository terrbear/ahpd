export const CLAUDE_TOOL_PROFILES = ['default', 'lean', 'lean-no-catalogs'] as const;

export type ClaudeToolProfile = (typeof CLAUDE_TOOL_PROFILES)[number];

const HOST_DUPLICATES = ['Workflow', 'ScheduleWakeup', 'ShareOnboardingGuide', 'ReportFindings'] as const;
const CATALOG_TOOLS = ['Agent', 'Skill'] as const;

/**
 * Which Claude Code built-in tools a profile keeps out of the model's context.
 *
 * Passed to the SDK as `disallowedTools`, which drops the schema rather than
 * only refusing the call. `lean` removes built-ins that duplicate a host's own
 * scheduling, workflow and reporting features. `lean-no-catalogs` also removes
 * Agent and Skill, which is what drops the agent and skill listings: the CLI
 * cannot omit either listing while its tool stays.
 */
export function toolProfileOf(value: unknown): { profile: ClaudeToolProfile; removed: readonly string[] } {
  const profile = value === undefined ? 'default' : value;
  if (profile === 'default') return { profile, removed: [] };
  if (profile === 'lean') return { profile, removed: [...HOST_DUPLICATES] };
  if (profile === 'lean-no-catalogs') return { profile, removed: [...HOST_DUPLICATES, ...CATALOG_TOOLS] };
  throw new Error(`claudeToolProfile must be one of ${CLAUDE_TOOL_PROFILES.join(', ')}`);
}
