import { create } from 'zustand';
import { apiClient } from '@/api/client';

// ──────────────────────────────────────────────────────────────────────────
// Compliance frameworks selectable as activity compliance tags for the current
// tenant.
//
// An org admin curates which frameworks (SOX / HIPAA / GDPR / …) their tenant
// uses (Settings → Data). The activity Compliance picker is driven from this
// list rather than a hardcoded constant. This store resolves the effective set
// for the active org by walking up to the first ancestor that carries an
// explicit config; an org that was never configured (no field) falls back to
// the built-in set below (back-compat with the previously hardcoded list).
//
// Unlike the sensitivity regimes (a fixed CUI/ITAR/EXPORT_CONTROLLED enum),
// frameworks are free-form — admins can add their own — so nothing here gates
// or validates against a closed set. Already-selected tags on an activity
// always render even if they're no longer in the active list.
// ──────────────────────────────────────────────────────────────────────────

export const BUILTIN_COMPLIANCE_FRAMEWORKS = [
  'SOX', 'HIPAA', 'GDPR', 'PCI-DSS', 'CCPA', 'FERPA', 'FISMA', 'NERC CIP',
  'ISO 27001', 'SOC 2', 'NIST', 'GLBA', 'FERC', 'EPA', 'OSHA', 'ADA', 'Other',
] as const;

interface OrgRow { id: string; parentId?: string | null; activeComplianceFrameworks?: string[] }

interface ComplianceState {
  frameworks: string[];
  loaded: boolean;
  fetch: (activeOrgId?: string) => Promise<void>;
}

export const useComplianceStore = create<ComplianceState>()((set) => ({
  frameworks: [...BUILTIN_COMPLIANCE_FRAMEWORKS],
  loaded: false,
  fetch: async (activeOrgId) => {
    try {
      const res = await apiClient.get<{ success: boolean; data: OrgRow[] }>('/organizations');
      const orgs = res.data || [];
      let cur = activeOrgId ? orgs.find((o) => o.id === activeOrgId) : undefined;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (Array.isArray(cur.activeComplianceFrameworks)) {
          set({ frameworks: cur.activeComplianceFrameworks, loaded: true });
          return;
        }
        cur = cur.parentId ? orgs.find((o) => o.id === cur!.parentId) : undefined;
      }
      set({ frameworks: [...BUILTIN_COMPLIANCE_FRAMEWORKS], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** The compliance frameworks selectable for the current tenant (defaults to the
 *  built-in set). Already-selected activity tags outside this list still show. */
export function useComplianceFrameworks(): string[] {
  return useComplianceStore((s) => s.frameworks);
}
