// Reports repository — the report `definition` is an opaque
// ReportDefinition JSON blob and round-trips through JSONB.

import type { StoredReport, ReportRun, ReportSchedule } from '../routes/reports';
import type { ReportDefinition } from '../services/report-engine';
import { saveStore } from '../lib/persistence';
import { jsonRepository, Repository } from './repository';
import { getPrisma, hasDatabase } from './prisma';

export function jsonReportsRepository(store: StoredReport[]): Repository<StoredReport> {
  return jsonRepository<StoredReport>(store, () => saveStore('reports', store));
}

type PrismaReportRow = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  ownerId: string | null;
  visibility: string;
  definition: unknown;
  lastRunAt: Date | null;
  runLog: unknown;
  schedule: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export interface PrismaReportDelegate {
  findMany(arg?: { where?: { orgId?: string } }): Promise<PrismaReportRow[]>;
  findUnique(arg: { where: { id: string } }): Promise<PrismaReportRow | null>;
  create(arg: { data: Record<string, unknown> }): Promise<PrismaReportRow>;
  update(arg: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaReportRow>;
  delete(arg: { where: { id: string } }): Promise<PrismaReportRow>;
}

function fromPrisma(r: PrismaReportRow): StoredReport {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    description: r.description ?? '',
    ownerId: r.ownerId ?? null,
    visibility: r.visibility as StoredReport['visibility'],
    definition: r.definition as unknown as ReportDefinition,
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    runLog: (Array.isArray(r.runLog) ? r.runLog : []) as ReportRun[],
    schedule: (r.schedule ?? null) as ReportSchedule | null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toPrismaData(row: Partial<StoredReport>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (row.id !== undefined) d.id = row.id;
  if (row.orgId !== undefined) d.orgId = row.orgId;
  if (row.name !== undefined) d.name = row.name;
  if (row.description !== undefined) d.description = row.description;
  if (row.ownerId !== undefined) d.ownerId = row.ownerId ?? null;
  if (row.visibility !== undefined) d.visibility = row.visibility;
  if (row.definition !== undefined) d.definition = row.definition;
  if (row.lastRunAt !== undefined) d.lastRunAt = row.lastRunAt ? new Date(row.lastRunAt) : null;
  if (row.runLog !== undefined) d.runLog = row.runLog;
  if (row.schedule !== undefined) d.schedule = row.schedule ?? null;
  if (row.createdAt !== undefined) d.createdAt = new Date(row.createdAt);
  return d;
}

export function prismaReportsRepository(
  clientFactory: () => { report: PrismaReportDelegate } = getPrisma as unknown as () => { report: PrismaReportDelegate },
): Repository<StoredReport> {
  return {
    async list(filter) {
      const client = clientFactory();
      const rows = filter?.orgId
        ? await client.report.findMany({ where: { orgId: filter.orgId } })
        : await client.report.findMany();
      return rows.map(fromPrisma);
    },
    async get(id) {
      const client = clientFactory();
      const row = await client.report.findUnique({ where: { id } });
      return row ? fromPrisma(row) : null;
    },
    async create(row) {
      const client = clientFactory();
      const created = await client.report.create({ data: toPrismaData(row) });
      return fromPrisma(created);
    },
    async update(id, patch) {
      const client = clientFactory();
      try {
        const data = toPrismaData(patch);
        delete data.updatedAt;
        const updated = await client.report.update({ where: { id }, data });
        return fromPrisma(updated);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return null;
        throw err;
      }
    },
    async delete(id) {
      const client = clientFactory();
      try {
        await client.report.delete({ where: { id } });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return false;
        throw err;
      }
    },
  };
}

export function getReportsRepository(store: StoredReport[]): Repository<StoredReport> {
  return hasDatabase()
    ? prismaReportsRepository()
    : jsonReportsRepository(store);
}
