import { expect, it } from 'vitest';
import { workProfileAction, workProfileRequest } from '../src/work-profile.js';

it('permits the Anton conversation, reconnection and configuration protocol', () => {
  for (const method of ['initialize', 'reconnect', 'ping', 'subscribe', 'unsubscribe', 'fetchTurns', 'listSessions', 'createSession', 'disposeSession', 'resolveSessionConfig', 'sessionConfigCompletions']) {
    expect(workProfileRequest(method, {})).toBeUndefined();
  }
  for (const type of ['chat/turnStarted', 'chat/turnResume', 'chat/turnCancelled', 'chat/inputCompleted', 'chat/toolCallConfirmed', 'chat/toolCallComplete', 'session/activeClientSet']) {
    expect(workProfileAction({ type })).toBeUndefined();
  }
  expect(workProfileAction({ type: 'session/configChanged', config: { model: 'model', permissionMode: 'default', effortLevel: 'high' } })).toBeUndefined();
  expect(workProfileRequest('resourceRead', { uri: 'ahpd-account://claude?cwd=/scratch' })).toBeUndefined();
});

it('refuses unknown operations and host execution surfaces by default', () => {
  for (const method of ['createTerminal', 'resourceWrite', 'resourceRead', 'createResourceWatch', 'resourceRequest', 'runAutomation', 'createChat', 'authenticate', 'shutdown', 'futureCommand']) {
    expect(workProfileRequest(method, { uri: 'file:///tmp/private' })).toContain('unavailable');
  }
  for (const type of ['terminal/input', 'session/mcpServerStartRequested', 'session/customizationToggled', 'chat/truncated', 'session/workingDirectorySet', 'future/action']) {
    expect(workProfileAction({ type })).toContain('unavailable');
  }
  for (const key of ['extraArgs', 'shellInitScripts', 'shellPath', 'computer', 'preset', 'isolation']) {
    expect(workProfileAction({ type: 'session/configChanged', config: { [key]: 'value' } })).toContain('unavailable');
    expect(workProfileRequest('createSession', { config: { [key]: 'value' } })).toContain('unavailable');
  }
});
