import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BoundTool } from '@ahpd/sdk';

const sdk = vi.hoisted(() => ({ servers: [] as Record<string, unknown>[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => {
    sdk.servers.push(given);
    return { type: 'sdk', name: given.name, tools: given.tools };
  },
  query: () => ({
    async *[Symbol.asyncIterator]() {},
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    toggleMcpServer: async () => {},
    reconnectMcpServer: async () => {},
    setMcpServers: async () => {},
    initializationResult: async () => ({}),
    mcpServerStatus: async () => [],
    reloadSkills: async () => ({ skills: [] }),
    reloadPlugins: async () => ({ plugins: [] }),
    supportedModels: async () => [],
    streamInput: async () => {},
    close: () => {},
  }),
}));

const { createSession } = await import('../src/session.js');

const offeredShape = (definition: BoundTool['definition']): Record<string, z.ZodTypeAny> => {
  sdk.servers = [];
  createSession({
    uri: 'ahp-session:/schema',
    chatUri: 'ahp-chat:/schema',
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-schema-')),
    emit: () => {},
    tools: [{ definition, run: () => 'ok' } as BoundTool],
  });
  const server = sdk.servers[0] as { tools: { inputSchema: Record<string, z.ZodTypeAny> }[] } | undefined;
  const shape = server?.tools[0]?.inputSchema;
  if (!shape) throw new Error('contributed schema was not registered');
  return shape;
};

it('keeps nested object requirements and enum validation for arrays of objects', () => {
  const shape = offeredShape({
    name: 'add_artifact_or_reference',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['artifact', 'reference'] },
              label: { type: 'string' },
              isArtifact: { type: 'boolean' },
              details: {
                type: 'object',
                properties: { source: { type: 'string' }, optional: { type: 'number' } },
                required: ['source'],
                additionalProperties: false,
              },
            },
            required: ['type', 'label', 'isArtifact'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
    },
  });
  const items = shape.items as z.ZodTypeAny;
  const valid = [{ type: 'artifact', label: 'guide', isArtifact: true, details: { source: 'docs' } }];
  expect(items.safeParse(valid).success).toBe(true);
  expect(items.safeParse([{ type: 'other', label: 'guide', isArtifact: true }]).success).toBe(false);
  expect(items.safeParse([{ type: 'artifact', isArtifact: true }]).success).toBe(false);
  expect(items.safeParse([{ type: 'artifact', label: 'guide', isArtifact: true, details: { optional: 2 } }]).success).toBe(false);
  expect(items.safeParse([{ type: 'artifact', label: 'guide', isArtifact: true, unexpected: true }]).success).toBe(false);
});

it('preserves open object schemas and enforces typed additional properties', () => {
  const shape = offeredShape({
    name: 'metadata',
    inputSchema: {
      type: 'object',
      properties: {
        open: { type: 'object', properties: { known: { type: 'string' } } },
        any: { type: 'object' },
        counts: { type: 'object', additionalProperties: { type: 'number' } },
      },
    },
  });
  const parsed = shape.open!.parse({ known: 'yes', extra: { kept: true } }) as Record<string, unknown>;
  expect(parsed).toEqual({ known: 'yes', extra: { kept: true } });
  expect(shape.any!.parse({ arbitrary: 3 })).toEqual({ arbitrary: 3 });
  expect(shape.counts!.safeParse({ good: 1, bad: 'two' }).success).toBe(false);
});

it('converts primitive enums beyond strings', () => {
  const shape = offeredShape({
    name: 'enum_values',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', enum: [1, 2] },
        boolean: { type: 'boolean', enum: [true, false] },
        inferred: { enum: ['alpha', 'beta'] },
      },
      required: ['number', 'boolean', 'inferred'],
    },
  });
  expect(shape.number!.safeParse(2).success).toBe(true);
  expect(shape.number!.safeParse(3).success).toBe(false);
  expect(shape.boolean!.safeParse(true).success).toBe(true);
  expect(shape.boolean!.safeParse('true').success).toBe(false);
  expect(shape.inferred!.safeParse('beta').success).toBe(true);
  expect(shape.inferred!.safeParse(1).success).toBe(false);
});
