import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Eager: Layout is on every authenticated page so a lazy boundary
// gains nothing. LoginPage is the unauthenticated entry — keep its
// first paint as fast as possible. Everything else is route-level
// code-split with React.lazy(); each page becomes its own chunk and
// only downloads when the user navigates to it.
import Layout from '@/components/Layout';
import Spinner from '@/components/Spinner';
import LoginPage from '@/pages/LoginPage';

const OidcCompletePage           = lazy(() => import('@/pages/OidcCompletePage'));
const DashboardPage              = lazy(() => import('@/pages/DashboardPage'));
const SetupHubPage               = lazy(() => import('@/pages/SetupHubPage'));
const ProcessCatalogPage         = lazy(() => import('@/pages/ProcessCatalogPage'));
const ValueStreamWizard          = lazy(() => import('@/pages/ValueStreamWizard'));
const ProcessVisualizationPage   = lazy(() => import('@/pages/ProcessVisualizationPage'));
const ProcessDataMapPage         = lazy(() => import('@/pages/ProcessDataMapPage'));
const ComparisonPage             = lazy(() => import('@/pages/ComparisonPage'));
const SystemsAndDataPage         = lazy(() => import('@/pages/SystemsAndDataPage'));
const AnalyzePage                = lazy(() => import('@/pages/AnalyzePage'));
const DataAssetsHubPage          = lazy(() => import('@/pages/DataAssetsHubPage'));
const SystemsHubPage             = lazy(() => import('@/pages/SystemsHubPage'));
const GapDetectionPage           = lazy(() => import('@/pages/GapDetectionPage'));
const OrganizationsPage          = lazy(() => import('@/pages/OrganizationsPage'));
const OrgVisualizationPage       = lazy(() => import('@/pages/OrgVisualizationPage'));
const PeoplePage                 = lazy(() => import('@/pages/PeoplePage'));
const PersonDetailPage           = lazy(() => import('@/pages/PersonDetailPage'));
const AgentsPage                 = lazy(() => import('@/pages/AgentsPage'));
const SkillsPage                 = lazy(() => import('@/pages/SkillsPage'));
const GovernanceGroupsPage       = lazy(() => import('@/pages/GovernanceGroupsPage'));
const GovernanceGroupDetailPage  = lazy(() => import('@/pages/GovernanceGroupDetailPage'));
const GovernanceVisualizationPage= lazy(() => import('@/pages/GovernanceVisualizationPage'));
const DataDomainsPage            = lazy(() => import('@/pages/DataDomainsPage'));
const DocumentationPage          = lazy(() => import('@/pages/DocumentationPage'));
const RolesPage                  = lazy(() => import('@/pages/RolesPage'));
const DataLineagePage            = lazy(() => import('@/pages/DataLineagePage'));
const GovernanceWorkPage         = lazy(() => import('@/pages/GovernanceWorkPage'));
const GovernancePoliciesPage     = lazy(() => import('@/pages/GovernancePoliciesPage'));
const GovernanceCalendarPage     = lazy(() => import('@/pages/GovernanceCalendarPage'));
const DecisionRightsPage         = lazy(() => import('@/pages/DecisionRightsPage'));
const BusinessGlossaryPage       = lazy(() => import('@/pages/BusinessGlossaryPage'));
const GovernanceFoundationPage   = lazy(() => import('@/pages/GovernanceFoundationPage'));
const EnterpriseViewPage         = lazy(() => import('@/pages/EnterpriseViewPage'));
const AnalysisPage               = lazy(() => import('@/pages/AnalysisPage'));
const ReportsPage                = lazy(() => import('@/pages/ReportsPage'));
const ReportBuilderPage          = lazy(() => import('@/pages/ReportBuilderPage'));
const CouncilScorecardPage       = lazy(() => import('@/pages/CouncilScorecardPage'));
const GovernanceExceptionsPage   = lazy(() => import('@/pages/GovernanceExceptionsPage'));
const AuditLogPage               = lazy(() => import('@/pages/AuditLogPage'));
const SettingsPage               = lazy(() => import('@/pages/SettingsPage'));
const BrandingPage               = lazy(() => import('@/pages/BrandingPage'));
const HelpPage                   = lazy(() => import('@/pages/HelpPage'));
const HelpTrainingPage           = lazy(() => import('@/pages/HelpTrainingPage'));
const RoadmapPage                = lazy(() => import('@/pages/RoadmapPage'));

// Quiet placeholder shown for the millisecond or two between route
// click and the lazy chunk arriving. A SkeletonRows-style block
// would be more polished but each page already renders its own
// skeleton on data load — a tiny "Loading…" line here keeps the
// inter-route gap from flashing the dashboard background.
function PageFallback() {
  return <Spinner label="Loading…" style={{ padding: '24px 16px', color: 'var(--color-text-muted)' }} />;
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/oidc-complete" element={<OidcCompletePage />} />
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/setup" element={<SetupHubPage />} />
          <Route path="/processes" element={<ProcessCatalogPage />} />
          <Route path="/processes/wizard" element={<ValueStreamWizard />} />
          <Route path="/processes/visualization" element={<ProcessVisualizationPage />} />
          <Route path="/processes/data-map" element={<ProcessDataMapPage />} />
          <Route path="/processes/compare" element={<ComparisonPage />} />
          {/* Combined pages */}
          <Route path="/systems-and-data" element={<SystemsAndDataPage />} />
          <Route path="/governance" element={<Navigate to="/governance-groups" replace />} />
          <Route path="/analyze" element={<AnalyzePage />} />
          {/* Legacy routes — kept for backward compatibility and deep links */}
          <Route path="/data-assets" element={<DataAssetsHubPage />} />
          {/* Orphan Assets folded into Data Assets as the "Unmapped" mapping
              filter. Redirect preserves old links (digest, AI, bookmarks). */}
          <Route path="/data-assets/orphans" element={<Navigate to="/data-assets?mapping=unmapped" replace />} />
          <Route path="/systems" element={<SystemsHubPage />} />
          {/* Data Mapping folded into the Process ↔ Data map as its Table
              view. Redirect preserves old links (dashboard, deep links). */}
          <Route path="/mappings" element={<Navigate to="/processes/data-map?view=table" replace />} />
          <Route path="/gap-detection" element={<GapDetectionPage />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/organizations/visualization" element={<OrgVisualizationPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:id" element={<PersonDetailPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/governance-groups" element={<GovernanceGroupsPage />} />
          <Route path="/governance-groups/:id" element={<GovernanceGroupDetailPage />} />
          <Route path="/governance/visualization" element={<GovernanceVisualizationPage />} />
          <Route path="/data-domains" element={<DataDomainsPage />} />
          {/* Merged surfaces — option B of the governance IA cleanup */}
          <Route path="/documentation" element={<DocumentationPage />} />
          <Route path="/operations-manual" element={<Navigate to="/documentation?tab=manual" replace />} />
          <Route path="/sops" element={<Navigate to="/documentation?tab=procedures" replace />} />
          <Route path="/dama-roles" element={<RolesPage />} />
          <Route path="/roles" element={<Navigate to="/dama-roles" replace />} />
          <Route path="/raci" element={<Navigate to="/dama-roles?tab=raci" replace />} />
          <Route path="/control-tower" element={<Navigate to="/enterprise-view" replace />} />
          {/* The Governance Maturity Scorecard tab was removed; its data still
              surfaces in the Executive Report. Old /scorecard links → Reports. */}
          <Route path="/scorecard" element={<Navigate to="/reports" replace />} />
          <Route path="/report" element={<Navigate to="/reports" replace />} />
          <Route path="/data-lineage" element={<DataLineagePage />} />
          {/* Data Quality folded into the Data Assets hub as the Quality /
              Rules tabs. Redirect preserves old links (digest, AI, bookmarks). */}
          <Route path="/data-quality" element={<Navigate to="/data-assets?tab=quality" replace />} />
          {/* Connections folded into the Systems hub as its second tab.
              Redirect preserves old links (Settings connector panel, bookmarks). */}
          <Route path="/connections" element={<Navigate to="/systems?tab=connections" replace />} />
          <Route path="/governance-work" element={<GovernanceWorkPage />} />
          <Route path="/governance-policies" element={<GovernancePoliciesPage />} />
          {/* Canonical alias — the page now covers Charter / Framework /
              Standard / Policy, so the broader URL reads honestly. The
              /governance-policies path is kept indefinitely as a
              back-compat alias since existing deep links and the
              sidebar still point at it. */}
          <Route path="/governance-documents" element={<GovernancePoliciesPage />} />
          <Route path="/governance-calendar" element={<GovernanceCalendarPage />} />
          <Route path="/decision-rights" element={<DecisionRightsPage />} />
          <Route path="/business-glossary" element={<BusinessGlossaryPage />} />
          {/* The Governance Program page was folded into Get Started (/setup):
              its lifecycle transitions, per-phase progress, and Next Actions
              now live there, with scope/principles on Governance → Foundation. */}
          <Route path="/governance-program" element={<Navigate to="/setup" replace />} />
          <Route path="/governance/foundation" element={<GovernanceFoundationPage />} />
          <Route path="/enterprise-view" element={<EnterpriseViewPage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/council-scorecard" element={<CouncilScorecardPage />} />
          <Route path="/governance-exceptions" element={<GovernanceExceptionsPage />} />
          <Route path="/reports/builder" element={<ReportBuilderPage />} />
          <Route path="/reports/builder/:id" element={<ReportBuilderPage />} />
          <Route path="/audit-log" element={<AuditLogPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/branding" element={<BrandingPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/help/training" element={<HelpTrainingPage />} />
          <Route path="/roadmap" element={<RoadmapPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
