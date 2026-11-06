import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';

export const executionFenceOf = (settings: Record<string, unknown>) => {
  const mode = settings.toolExecutionFence === undefined ? 'off' : settings.toolExecutionFence;
  if (mode !== 'off' && mode !== 'deny-all' && mode !== 'allowlist') {
    throw new Error('toolExecutionFence must be one of off, deny-all, allowlist');
  }
  const supplied = settings.toolExecutionAllowlist;
  const names = supplied === undefined && mode !== 'allowlist' ? [] : supplied;
  if (!Array.isArray(names) || names.length > 512
    || names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(name))
    || new Set(names).size !== names.length) {
    throw new Error('toolExecutionAllowlist must contain at most 512 unique exact tool names of 1-256 letters, digits, underscores or hyphens');
  }
  if (mode !== 'allowlist' && names.length > 0) {
    throw new Error('toolExecutionAllowlist must be empty unless toolExecutionFence is allowlist');
  }
  const fixedNames = Object.freeze([...names] as string[]);
  const allowed = new Set(fixedNames);
  const blocks = (name: unknown) => mode === 'deny-all' || mode === 'allowlist' && (typeof name !== 'string' || !allowed.has(name));
  const message = 'Tool execution is outside this session’s fixed allowlist.';
  const preToolUse: HookCallback = async (input) => {
    if (!blocks('tool_name' in input ? input.tool_name : undefined)) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } };
  };
  const wrapHook = (ordinary: HookCallback): HookCallback => mode === 'off' ? ordinary : async (input, id, options) => {
    if (blocks('tool_name' in input ? input.tool_name : undefined)) return preToolUse(input, id, options);
    return ordinary(input, id, options);
  };
  const wrap = (ordinary: CanUseTool): CanUseTool => mode === 'off' ? ordinary : async (name, input, options) => {
    if (blocks(name)) return { behavior: 'deny', message };
    return ordinary(name, input, options);
  };
  return { mode, names: fixedNames, preToolUse, wrapHook, wrap };
};
