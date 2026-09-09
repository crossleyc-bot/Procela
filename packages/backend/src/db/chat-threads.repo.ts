// Chat-threads repository — a persisted AI-assistant conversation. The
// `messages` field is the opaque ChatMessage[] transcript and round-trips
// through JSONB.

import type { ChatThread } from '../routes/chat';
import type { ChatMessage } from '../types';
import { saveStore } from '../lib/persistence';
import { jsonRepository, Repository } from './repository';
import { getPrisma, hasDatabase } from './prisma';

export function jsonChatThreadsRepository(store: ChatThread[]): Repository<ChatThread> {
  return jsonRepository<ChatThread>(store, () => saveStore('chat-threads', store));
}

type PrismaChatThreadRow = {
  id: string;
  orgId: string;
  ownerId: string | null;
  title: string;
  messages: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export interface PrismaChatThreadDelegate {
  findMany(arg?: { where?: { orgId?: string } }): Promise<PrismaChatThreadRow[]>;
  findUnique(arg: { where: { id: string } }): Promise<PrismaChatThreadRow | null>;
  create(arg: { data: Record<string, unknown> }): Promise<PrismaChatThreadRow>;
  update(arg: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaChatThreadRow>;
  delete(arg: { where: { id: string } }): Promise<PrismaChatThreadRow>;
}

function fromPrisma(r: PrismaChatThreadRow): ChatThread {
  return {
    id: r.id,
    orgId: r.orgId,
    ownerId: r.ownerId ?? null,
    title: r.title,
    messages: (Array.isArray(r.messages) ? r.messages : []) as ChatMessage[],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toPrismaData(row: Partial<ChatThread>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (row.id !== undefined) d.id = row.id;
  if (row.orgId !== undefined) d.orgId = row.orgId;
  if (row.ownerId !== undefined) d.ownerId = row.ownerId ?? null;
  if (row.title !== undefined) d.title = row.title;
  if (row.messages !== undefined) d.messages = row.messages;
  if (row.createdAt !== undefined) d.createdAt = new Date(row.createdAt);
  return d;
}

export function prismaChatThreadsRepository(
  clientFactory: () => { chatThread: PrismaChatThreadDelegate } =
    getPrisma as unknown as () => { chatThread: PrismaChatThreadDelegate },
): Repository<ChatThread> {
  return {
    async list(filter) {
      const client = clientFactory();
      const rows = filter?.orgId
        ? await client.chatThread.findMany({ where: { orgId: filter.orgId } })
        : await client.chatThread.findMany();
      return rows.map(fromPrisma);
    },
    async get(id) {
      const client = clientFactory();
      const row = await client.chatThread.findUnique({ where: { id } });
      return row ? fromPrisma(row) : null;
    },
    async create(row) {
      const client = clientFactory();
      const created = await client.chatThread.create({ data: toPrismaData(row) });
      return fromPrisma(created);
    },
    async update(id, patch) {
      const client = clientFactory();
      try {
        const data = toPrismaData(patch);
        delete data.updatedAt;
        const updated = await client.chatThread.update({ where: { id }, data });
        return fromPrisma(updated);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return null;
        throw err;
      }
    },
    async delete(id) {
      const client = clientFactory();
      try {
        await client.chatThread.delete({ where: { id } });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return false;
        throw err;
      }
    },
  };
}

export function getChatThreadsRepository(store: ChatThread[]): Repository<ChatThread> {
  return hasDatabase()
    ? prismaChatThreadsRepository()
    : jsonChatThreadsRepository(store);
}
