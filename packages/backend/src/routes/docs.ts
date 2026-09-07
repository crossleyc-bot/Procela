import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdownToPdf } from '../services/markdown-pdf';
import { renderMarkdownToHtml } from '../services/markdown-html';

const router = Router();

const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Procela API',
    version: '1.0.0',
    description: 'Process-to-data governance platform API. Procela helps organizations connect business processes to the data and systems that support them.',
  },
  servers: [
    { url: '/api/v1', description: 'API v1' },
  ],
  tags: [
    { name: 'System', description: 'Health checks and system status' },
    { name: 'Auth', description: 'Authentication and session management' },
    { name: 'Organizations', description: 'Organization CRUD and import' },
    { name: 'People', description: 'People CRUD, import, and 360 view' },
    { name: 'Process Catalog', description: 'Process hierarchy management (value streams, processes, activities, etc.)' },
    { name: 'Systems', description: 'System registry CRUD and import' },
    { name: 'Data Assets', description: 'Data asset CRUD' },
    { name: 'Mappings', description: 'Process-to-data mappings' },
    { name: 'Governance Groups', description: 'Governance group CRUD and membership' },
    { name: 'Governance Roles', description: 'Governance role assignments' },
    { name: 'Data Domains', description: 'Data domain CRUD and summary' },
    { name: 'Dashboard', description: 'Dashboard statistics' },
    { name: 'Chat', description: 'AI-powered chat assistant' },
    { name: 'Search', description: 'Global search across entities' },
    { name: 'Audit', description: 'Audit log' },
    { name: 'AI', description: 'AI template generation' },
  ],
  paths: {
    // ── System / Health ──
    '/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        responses: { '200': { description: 'Server is healthy' } },
      },
    },
    '/health/config': {
      get: {
        summary: 'Configuration status flags',
        tags: ['System'],
        responses: { '200': { description: 'Configuration flags (no secrets exposed)' } },
      },
    },

    // ── Auth ──
    '/auth/login': {
      post: {
        summary: 'Login with credentials',
        tags: ['Auth'],
        responses: { '200': { description: 'Access and refresh tokens' } },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Refresh access token',
        tags: ['Auth'],
        responses: { '200': { description: 'New access token' } },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Logout and invalidate session',
        tags: ['Auth'],
        responses: { '200': { description: 'Session invalidated' } },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Get current authenticated user',
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Current user profile' } },
      },
    },
    '/auth/providers': {
      get: {
        summary: 'List available auth providers',
        tags: ['Auth'],
        responses: { '200': { description: 'List of configured identity providers' } },
      },
    },
    '/auth/config': {
      get: {
        summary: 'Get auth configuration',
        tags: ['Auth'],
        responses: { '200': { description: 'Auth configuration' } },
      },
      put: {
        summary: 'Update auth configuration',
        tags: ['Auth'],
        responses: { '200': { description: 'Auth configuration updated' } },
      },
    },
    '/auth/accessible-orgs': {
      get: {
        summary: 'List organizations accessible to current user',
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'List of accessible organizations' } },
      },
    },

    // ── Organizations ──
    '/organizations': {
      get: {
        summary: 'List all organizations',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of organizations' } },
      },
      post: {
        summary: 'Create a new organization',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Organization created' } },
      },
    },
    '/organizations/{id}': {
      get: {
        summary: 'Get organization by ID',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Organization details' } },
      },
      put: {
        summary: 'Update an organization',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Organization updated' } },
      },
      delete: {
        summary: 'Delete an organization',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Organization deleted' } },
      },
    },
    '/organizations/import': {
      post: {
        summary: 'Bulk import organizations from CSV or JSON',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Import results' } },
      },
    },

    // ── People ──
    '/people': {
      get: {
        summary: 'List all people',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of people' } },
      },
      post: {
        summary: 'Create a new person',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Person created' } },
      },
    },
    '/people/{id}': {
      get: {
        summary: 'Get person by ID',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Person details' } },
      },
      put: {
        summary: 'Update a person',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Person updated' } },
      },
      delete: {
        summary: 'Delete a person',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Person deleted' } },
      },
    },
    '/people/{id}/360': {
      get: {
        summary: 'Get 360-degree view of a person (roles, ownership, assignments)',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Full 360 view of person' } },
      },
    },
    '/people/import': {
      post: {
        summary: 'Bulk import people from CSV or JSON',
        tags: ['People'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Import results' } },
      },
    },

    // ── Process Catalog ──
    '/process-catalog': {
      get: {
        summary: 'List process catalog as tree with stats',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Process tree, stats, and valid children map' } },
      },
    },
    '/process-catalog/value-streams': {
      get: {
        summary: 'List value streams only',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of value stream nodes' } },
      },
    },
    '/process-catalog/nodes/{id}': {
      get: {
        summary: 'Get a single process node by ID',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Process node details with children' } },
      },
      put: {
        summary: 'Update a process node',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Process node updated' } },
      },
      delete: {
        summary: 'Delete a process node and its children',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Process node deleted' } },
      },
    },
    '/process-catalog/nodes': {
      post: {
        summary: 'Create a new process node',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Process node created' } },
      },
    },
    '/process-catalog/nodes/{id}/validate': {
      get: {
        summary: 'Validate a process node (check required children)',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Validation result' } },
      },
    },
    '/process-catalog/flows': {
      get: {
        summary: 'List all flow relationships',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of flow relationships' } },
      },
      post: {
        summary: 'Create a flow relationship between nodes',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Flow created' } },
      },
    },
    '/process-catalog/flows/{id}': {
      delete: {
        summary: 'Delete a flow relationship',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Flow deleted' } },
      },
    },
    '/process-catalog/flows/by-node/{nodeId}': {
      get: {
        summary: 'Get flows for a specific node',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Flows for the node' } },
      },
    },
    '/process-catalog/apply-template': {
      post: {
        summary: 'Apply an AI-generated industry template to the catalog',
        tags: ['Process Catalog'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Template applied' } },
      },
    },

    // ── Systems ──
    '/systems': {
      get: {
        summary: 'List all systems',
        tags: ['Systems'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of systems with system types' } },
      },
      post: {
        summary: 'Create a new system',
        tags: ['Systems'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'System created' } },
      },
    },
    '/systems/{id}': {
      get: {
        summary: 'Get system by ID',
        tags: ['Systems'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'System details' } },
      },
      put: {
        summary: 'Update a system',
        tags: ['Systems'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'System updated' } },
      },
      delete: {
        summary: 'Delete a system',
        tags: ['Systems'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'System deleted' } },
      },
    },
    '/systems/import': {
      post: {
        summary: 'Bulk import systems from CSV or JSON',
        tags: ['Systems'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Import results' } },
      },
    },

    // ── Data Assets ──
    '/data-assets': {
      get: {
        summary: 'List all data assets',
        tags: ['Data Assets'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of data assets with system refs' } },
      },
      post: {
        summary: 'Create a new data asset',
        tags: ['Data Assets'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Data asset created' } },
      },
    },
    '/data-assets/{id}': {
      get: {
        summary: 'Get data asset by ID',
        tags: ['Data Assets'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Data asset details' } },
      },
      put: {
        summary: 'Update a data asset',
        tags: ['Data Assets'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Data asset updated' } },
      },
      delete: {
        summary: 'Delete a data asset',
        tags: ['Data Assets'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Data asset deleted' } },
      },
    },

    // ── Mappings ──
    '/mappings': {
      get: {
        summary: 'List all process-to-data mappings',
        tags: ['Mappings'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of mappings' } },
      },
      post: {
        summary: 'Create a new mapping',
        tags: ['Mappings'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Mapping created' } },
      },
    },
    '/mappings/{id}': {
      put: {
        summary: 'Update a mapping',
        tags: ['Mappings'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Mapping updated' } },
      },
      delete: {
        summary: 'Delete a mapping',
        tags: ['Mappings'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Mapping deleted' } },
      },
    },
    '/mappings/by-step/{stepId}': {
      get: {
        summary: 'Get mappings for a specific process step',
        tags: ['Mappings'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'stepId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Mappings for the step' } },
      },
    },
    '/mappings/by-asset/{assetId}': {
      get: {
        summary: 'Get mappings for a specific data asset',
        tags: ['Mappings'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Mappings for the asset' } },
      },
    },

    // ── Governance Groups ──
    '/governance-groups': {
      get: {
        summary: 'List all governance groups',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of governance groups' } },
      },
      post: {
        summary: 'Create a new governance group',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Governance group created' } },
      },
    },
    '/governance-groups/{id}': {
      get: {
        summary: 'Get governance group by ID',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Governance group details with members' } },
      },
      put: {
        summary: 'Update a governance group',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Governance group updated' } },
      },
      delete: {
        summary: 'Delete a governance group',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Governance group deleted' } },
      },
    },
    '/governance-groups/{id}/members': {
      post: {
        summary: 'Add a member to a governance group',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Member added' } },
      },
    },
    '/governance-groups/{id}/members/{personId}': {
      delete: {
        summary: 'Remove a member from a governance group',
        tags: ['Governance Groups'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'personId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Member removed' } },
      },
    },

    // ── Governance Roles ──
    '/dama-roles': {
      get: {
        summary: 'List all governance role assignments',
        tags: ['Governance Roles'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of governance role assignments' } },
      },
      post: {
        summary: 'Create a governance role assignment',
        tags: ['Governance Roles'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Governance role assigned' } },
      },
    },
    '/dama-roles/{id}': {
      delete: {
        summary: 'Delete a governance role assignment',
        tags: ['Governance Roles'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Governance role assignment deleted' } },
      },
    },
    '/dama-roles/by-person/{personId}': {
      get: {
        summary: 'Get governance roles for a specific person',
        tags: ['Governance Roles'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'personId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Governance roles for the person' } },
      },
    },
    '/dama-roles/summary': {
      get: {
        summary: 'Governance roles summary with counts',
        tags: ['Governance Roles'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Summary of governance role assignments' } },
      },
    },

    // ── Data Domains ──
    '/data-domains': {
      get: {
        summary: 'List all data domains',
        tags: ['Data Domains'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Array of data domains' } },
      },
      post: {
        summary: 'Create a new data domain',
        tags: ['Data Domains'],
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Data domain created' } },
      },
    },
    '/data-domains/{id}': {
      get: {
        summary: 'Get data domain by ID',
        tags: ['Data Domains'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Data domain details' } },
      },
      put: {
        summary: 'Update a data domain',
        tags: ['Data Domains'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Data domain updated' } },
      },
      delete: {
        summary: 'Delete a data domain',
        tags: ['Data Domains'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Data domain deleted' } },
      },
    },
    '/data-domains/summary': {
      get: {
        summary: 'Data domains summary with asset counts',
        tags: ['Data Domains'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Summary of data domains' } },
      },
    },

    // ── Dashboard ──
    '/dashboard/stats': {
      get: {
        summary: 'Get dashboard statistics',
        tags: ['Dashboard'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Dashboard stats including coverage, governance, gaps' } },
      },
    },

    // ── Chat ──
    '/chat': {
      post: {
        summary: 'Send a message to the AI assistant',
        tags: ['Chat'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'AI assistant response' } },
      },
    },

    // ── Search ──
    '/search': {
      get: {
        summary: 'Global search across all entities',
        tags: ['Search'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' }],
        responses: { '200': { description: 'Search results grouped by entity type' } },
      },
    },

    // ── Audit ──
    '/audit': {
      get: {
        summary: 'Query audit log entries',
        tags: ['Audit'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' }, description: 'Max entries to return' }],
        responses: { '200': { description: 'Array of audit log entries' } },
      },
    },

    // ── AI ──
    '/ai/generate-template': {
      post: {
        summary: 'Generate an industry process template using AI',
        tags: ['AI'],
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Generated process hierarchy template' } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
};

/**
 * GET /api/v1/docs — Returns the OpenAPI JSON spec
 */
router.get('/', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

/**
 * GET /api/v1/docs/ui — Returns a simple HTML page rendering the spec with Swagger UI
 */
router.get('/ui', (_req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Procela API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/v1/docs',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
  res.type('html').send(html);
});

/**
 * GET /api/v1/docs/training — Returns the training guide as raw
 * markdown. The frontend renders it inline at /help/training. Single
 * source of truth: docs/TRAINING.md at the repo root, shipped as
 * customer-facing collateral.
 *
 * The file is resolved relative to the repo root since the docs folder
 * isn't bundled into dist/. In production builds the same relative
 * path holds because we cp the docs/ tree alongside dist/.
 */
const TRAINING_GUIDE_CANDIDATES = [
  // Dev: routes/docs.ts → src/routes → packages/backend → packages → repo root
  path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'TRAINING.md'),
  // Built artefact: dist/routes/docs.js sits one level lower
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'docs', 'TRAINING.md'),
  // Container deployment where docs/ is copied next to dist/
  path.resolve(__dirname, '..', '..', 'docs', 'TRAINING.md'),
];

let cachedTrainingMd: { contents: string; mtimeMs: number; path: string } | null = null;

function readTrainingGuide(): { contents: string; path: string } {
  // mtime check so an editor save reloads on the next request without
  // having to bounce the server.
  for (const candidate of TRAINING_GUIDE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate);
      if (cachedTrainingMd && cachedTrainingMd.path === candidate && cachedTrainingMd.mtimeMs === stat.mtimeMs) {
        return { contents: cachedTrainingMd.contents, path: cachedTrainingMd.path };
      }
      const contents = fs.readFileSync(candidate, 'utf-8');
      cachedTrainingMd = { contents, mtimeMs: stat.mtimeMs, path: candidate };
      return { contents, path: candidate };
    } catch { /* try next candidate */ }
  }
  throw new Error('TRAINING.md not found in any known location.');
}

router.get('/training', (_req: Request, res: Response) => {
  try {
    const { contents, path: resolvedPath } = readTrainingGuide();
    res.json({
      success: true,
      data: {
        markdown: contents,
        sourcePath: resolvedPath,
        bytes: contents.length,
      },
    });
  } catch (err: any) {
    res.status(404).json({
      success: false,
      error: err?.message || 'Training guide not available.',
    });
  }
});

/**
 * Help guide source. Hand-curated when written and refreshable via
 *   node packages/backend/scripts/extract-help-markdown.js
 * which auto-extracts the structural content out of HelpPage.tsx.
 *
 * Lives next to the compiled service so the same relative resolution
 * works in dev (src/docs) and in prod (dist/docs after a build that
 * mirrors the docs directory). The lookup falls back to the source
 * tree if dist isn't available, then bails with a 404.
 */
const HELP_GUIDE_CANDIDATES = [
  path.resolve(__dirname, '..', 'docs', 'HELP.md'),
  path.resolve(__dirname, '..', '..', 'src', 'docs', 'HELP.md'),
];

let cachedHelpMd: { contents: string; mtimeMs: number; path: string } | null = null;

function readHelpGuide(): { contents: string; path: string } {
  for (const candidate of HELP_GUIDE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate);
      if (cachedHelpMd && cachedHelpMd.path === candidate && cachedHelpMd.mtimeMs === stat.mtimeMs) {
        return { contents: cachedHelpMd.contents, path: cachedHelpMd.path };
      }
      const contents = fs.readFileSync(candidate, 'utf-8');
      cachedHelpMd = { contents, mtimeMs: stat.mtimeMs, path: candidate };
      return { contents, path: candidate };
    } catch { /* try next */ }
  }
  throw new Error('HELP.md not found in any known location.');
}

/**
 * GET /api/v1/docs/training.pdf — generated PDF of the training guide.
 * Streams a Buffer back with the right Content-Disposition so it
 * renders inline in browsers' PDF viewer when opened, but also
 * downloads cleanly when saved.
 */
router.get('/training.pdf', async (_req: Request, res: Response) => {
  try {
    const { contents } = readTrainingGuide();
    const buffer = await renderMarkdownToPdf(contents, {
      title: 'Procela Training Guide',
      subtitle: 'A 90-minute click-by-click walkthrough using the Tidewater Utilities fixture data.',
      footer: `Procela Training Guide  ·  ${new Date().toISOString().slice(0, 10)}`,
    });
    res.type('application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="procela-training-guide.pdf"');
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'PDF generation failed.' });
  }
});

/**
 * GET /api/v1/docs/help.html — generated HTML of the help guide.
 *
 * Serves a self-contained, styled, searchable HTML page (no
 * outbound asset requests). The old PDF path (/help.pdf) was
 * retired in favour of this — copy/paste, Ctrl-F, and responsive
 * resize all work now; the print stylesheet still produces a
 * clean paper copy for users who want one.
 */
router.get('/help.html', (_req: Request, res: Response) => {
  try {
    const { contents } = readHelpGuide();
    const html = renderMarkdownToHtml(contents, {
      title: 'Procela Help Guide',
      subtitle: 'Feature-by-feature reference for the platform.',
    });
    res.type('text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    // Allow the in-app /help page to embed this guide in a same-origin
    // iframe. The global helmet config sets frame-ancestors 'none' +
    // X-Frame-Options: DENY; this is a static, read-only, credential-free
    // reference doc, so relaxing it to same-origin here is safe. (The app
    // and this API are one origin behind the dev proxy and CloudFront.)
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Self-contained doc: it ships its own inline <style> and a small inline
    // scroll-spy <script>, both authored here (no user input), so allow
    // inline for this one static response. frame-ancestors 'self' lets the
    // in-app /help page embed it same-origin.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' https: data:; frame-ancestors 'self'",
    );
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'HTML render failed.' });
  }
});

export default router;
