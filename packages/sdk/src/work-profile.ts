import type { Bag } from './types/common.js';

const methods = new Set([
  'initialize', 'reconnect', 'ping', 'subscribe', 'unsubscribe', 'fetchTurns',
  'listSessions', 'createSession', 'disposeSession', 'resolveSessionConfig',
  'sessionConfigCompletions',
]);
const actions = new Set([
  'chat/turnStarted', 'chat/turnResume', 'chat/turnCancelled',
  'chat/pendingMessageSet', 'chat/pendingMessageRemoved', 'chat/queuedMessagesReordered',
  'chat/draftChanged', 'chat/toolCallConfirmed', 'chat/inputCompleted',
  'chat/inputAnswerChanged', 'chat/toolCallResultConfirmed', 'chat/toolCallComplete',
  'session/titleChanged', 'session/configChanged', 'session/activeClientSet', 'root/configChanged',
  'chat/toolCallContentChanged',
]);
const configKeys = new Set([
  'model', 'permissionMode', 'permissions', 'effort', 'effortLevel', 'maxThinkingTokens',
  'toolExecutionFence', 'toolExecutionAllowlist',
  'antonLocalExecutor', 'builtInTools', 'contributedTools', 'claudeConfigIsolation',
  'extraArgsPolicy', 'claudeToolProfile', 'captureSdkInitToolManifest',
]);
const bag = (value: unknown): Bag => typeof value === 'object' && value !== null ? value as Bag : {};

export function workProfileRequest(method: string, params: Bag): string | undefined {
  if (method === 'dispatchAction') return workProfileAction(bag(params.action));
  if (method === 'resourceRead' && /^ahpd-account:\/\/(claude|codex)(\?cwd=[^#]*)?$/.test(String(params.uri ?? ''))) return undefined;
  if (!methods.has(method)) return `${method} is unavailable in local-executor-v1`;
  if (method === 'createSession') {
    const config = bag(params.config);
    const unsafe = Object.keys(config).find((key) => !configKeys.has(key));
    if (unsafe !== undefined) return `Session setting ${unsafe} is unavailable in local-executor-v1`;
    if (params.fork !== undefined || params.forkFrom !== undefined) return 'Forking is unavailable in local-executor-v1';
  }
  return undefined;
}

export function workProfileAction(action: Bag): string | undefined {
  const type = String(action.type ?? '');
  if (!actions.has(type)) return `${type} is unavailable in local-executor-v1`;
  if (type === 'root/configChanged') {
    if (Object.keys(bag(action.config)).length > 0) return 'Host settings cannot change in local-executor-v1';
  }
  if (type === 'session/configChanged') {
    const unsafe = Object.keys(bag(action.config)).find((key) => !configKeys.has(key));
    if (unsafe !== undefined) return `Session setting ${unsafe} is unavailable in local-executor-v1`;
  }
  return undefined;
}
