/**
 * Live agent capability registry (in-memory).
 *
 * Agents announce what they can do via POST /capability on the HTTP bridge. Entries go stale
 * after capabilityTTL ms without an update, and stale agents are never selected for routing.
 * Separate from agent-registry.ts, which is the static prototype table.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface AgentCapabilities {
  name: string;
  bash: boolean;
  fileOps: boolean;
  languages: string[];
  tools: string[];
  lastSeen: string;
}

export interface AgentCapabilityView extends AgentCapabilities {
  stale: boolean;
}

/** A routing requirement. Shorthand strings: "bash", "fileOps", "language:ts", "tool:vitest". */
export type CapabilityRequirement = string | { bash?: boolean; fileOps?: boolean; languages?: string[]; tools?: string[] };

export interface AgentRegistryConfig {
  capabilityTTL: number;
  maxAgents: number;
  maxListItems: number;
}

const DEFAULTS: AgentRegistryConfig = {
  capabilityTTL: 60000,
  maxAgents: 100,
  maxListItems: 50,
};

const MAX_ITEM_CHARS = 64;
const ITEM = /^[a-z0-9][a-z0-9._+-]*$/;

/** Reads the agentRegistry section of orchestrator.config.json. Missing values fall back to defaults. */
export function loadAgentRegistryConfig(configPath?: string): AgentRegistryConfig {
  const file = configPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'orchestrator.config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...(raw.agentRegistry ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export interface CapabilityRegistry {
  /** Stores or refreshes an agent. Returns an error string if the input is invalid or the registry is full. */
  register(input: unknown): { ok: true; agent: AgentCapabilities } | { ok: false; error: string };
  getAllAgents(): AgentCapabilityView[];
  /** Fresh agents that satisfy every part of the requirement, sorted by name. */
  getAgentsByCapability(req: CapabilityRequirement): AgentCapabilityView[];
  /** True when the named agent is registered, fresh, and satisfies the requirement. */
  satisfies(name: string, req: CapabilityRequirement): boolean;
  /** Parses a shorthand string or object into the object form. Returns an error string if malformed. */
  normalize(req: unknown): { ok: true; req: Exclude<CapabilityRequirement, string> } | { ok: false; error: string };
  ttl: number;
}

export function createCapabilityRegistry(
  config: AgentRegistryConfig = loadAgentRegistryConfig(),
  now: () => number = Date.now,
): CapabilityRegistry {
  const agents = new Map<string, AgentCapabilities & { at: number }>();

  const listOk = (v: unknown, name: string): string | null => {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${name} must be an array`;
    if (v.length > config.maxListItems) return `${name} exceeds ${config.maxListItems} items`;
    for (const item of v) {
      if (typeof item !== 'string' || item.length > MAX_ITEM_CHARS || !ITEM.test(item.toLowerCase())) {
        return `${name} items must be short lowercase identifiers`;
      }
    }
    return null;
  };

  const isFresh = (at: number) => now() - at <= config.capabilityTTL;

  const view = (a: AgentCapabilities & { at: number }): AgentCapabilityView => {
    const { at, ...rest } = a;
    return { ...rest, stale: !isFresh(at) };
  };

  const normalize: CapabilityRegistry['normalize'] = (req) => {
    if (typeof req === 'string') {
      if (req === 'bash' || req === 'fileOps') return { ok: true, req: { [req]: true } };
      const [kind, value] = req.split(':');
      if (kind === 'language' && value) return { ok: true, req: { languages: [value.toLowerCase()] } };
      if (kind === 'tool' && value) return { ok: true, req: { tools: [value.toLowerCase()] } };
      return { ok: false, error: `unknown capability requirement: ${req}` };
    }
    if (req && typeof req === 'object' && !Array.isArray(req)) {
      const r = req as Record<string, unknown>;
      for (const k of ['bash', 'fileOps'] as const) {
        if (r[k] !== undefined && typeof r[k] !== 'boolean') return { ok: false, error: `${k} must be boolean` };
      }
      const err = listOk(r.languages, 'languages') ?? listOk(r.tools, 'tools');
      if (err) return { ok: false, error: err };
      return {
        ok: true,
        req: {
          bash: r.bash === true ? true : undefined,
          fileOps: r.fileOps === true ? true : undefined,
          languages: (r.languages as string[] | undefined)?.map((s) => s.toLowerCase()),
          tools: (r.tools as string[] | undefined)?.map((s) => s.toLowerCase()),
        },
      };
    }
    return { ok: false, error: 'requiresCapability must be a string or object' };
  };

  const matches = (a: AgentCapabilities, req: Exclude<CapabilityRequirement, string>): boolean => {
    if (req.bash && !a.bash) return false;
    if (req.fileOps && !a.fileOps) return false;
    if (req.languages && !req.languages.every((l) => a.languages.includes(l))) return false;
    if (req.tools && !req.tools.every((t) => a.tools.includes(t))) return false;
    return true;
  };

  const resolve = (req: CapabilityRequirement) => {
    const n = normalize(req);
    return n.ok ? n.req : null;
  };

  return {
    ttl: config.capabilityTTL,
    normalize,

    register(input) {
      if (!input || typeof input !== 'object') return { ok: false, error: 'body must be an object' };
      const b = input as Record<string, unknown>;
      if (typeof b.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.name)) {
        return { ok: false, error: 'name must be 1-64 chars of letters, digits, _ or -' };
      }
      for (const k of ['bash', 'fileOps'] as const) {
        if (typeof b[k] !== 'boolean') return { ok: false, error: `${k} must be boolean` };
      }
      const err = listOk(b.languages ?? [], 'languages') ?? listOk(b.tools ?? [], 'tools');
      if (err) return { ok: false, error: err };

      if (!agents.has(b.name) && agents.size >= config.maxAgents) {
        return { ok: false, error: `registry is full (${config.maxAgents} agents)` };
      }
      const at = now();
      const agent = {
        name: b.name,
        bash: b.bash as boolean,
        fileOps: b.fileOps as boolean,
        languages: ((b.languages ?? []) as string[]).map((s) => s.toLowerCase()),
        tools: ((b.tools ?? []) as string[]).map((s) => s.toLowerCase()),
        lastSeen: new Date(at).toISOString(),
        at,
      };
      agents.set(agent.name, agent);
      const { at: _at, ...pub } = agent;
      return { ok: true, agent: pub };
    },

    getAllAgents: () => [...agents.values()].map(view).sort((a, b) => a.name.localeCompare(b.name)),

    getAgentsByCapability(req) {
      const r = resolve(req);
      if (!r) return [];
      return [...agents.values()]
        .filter((a) => isFresh(a.at) && matches(a, r))
        .map(view)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    satisfies(name, req) {
      const r = resolve(req);
      const a = agents.get(name);
      return !!r && !!a && isFresh(a.at) && matches(a, r);
    },
  };
}
