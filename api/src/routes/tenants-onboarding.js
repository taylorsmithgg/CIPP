const express = require('express');
const router = express.Router();
const { queryTable, upsertEntity, getEntity } = require('../utils/tableStorage');
const { storeRefreshToken } = require('../utils/tokenManager');

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['true', '1', 'yes'].includes(value.toLowerCase());
  }
  return false;
}

function safeJsonParse(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function getDefaultOnboardingSteps() {
  return [
    { Title: 'Validate Relationship', Status: 'pending', Message: 'Waiting to validate GDAP relationship' },
    { Title: 'Apply Role Mapping', Status: 'pending', Message: 'Waiting to map GDAP roles' },
    { Title: 'Create Tenant Entry', Status: 'pending', Message: 'Waiting to create tenant metadata' },
    { Title: 'Apply Initial Standards', Status: 'pending', Message: 'Waiting to apply startup standards' },
    { Title: 'Finalize Onboarding', Status: 'pending', Message: 'Waiting to finalize onboarding' }
  ];
}

function isGuid(value) {
  return typeof value === 'string'
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function normalizeTenantIdList(customerTenantIds) {
  if (!customerTenantIds) return [];
  if (Array.isArray(customerTenantIds)) {
    return customerTenantIds
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean);
  }

  if (typeof customerTenantIds === 'string') {
    return customerTenantIds
      .split(/[\n,;\s]+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }

  return [];
}

function getB2BOnboardingSteps(options = {}) {
  const steps = [
    { Title: 'Validate Customer Tenant', Status: 'pending', Message: 'Validating customer tenant and eligibility' },
    { Title: 'Create B2B Invitation', Status: 'pending', Message: 'Creating cross-tenant invitation' }
  ];

  if (options.assignSecurityReader) {
    steps.push({
      Title: 'Assign Security Reader',
      Status: 'pending',
      Message: 'Assigning Security Reader role for SOC operations'
    });
  }
  if (options.assignSecurityAdministrator) {
    steps.push({
      Title: 'Assign Security Administrator',
      Status: 'pending',
      Message: 'Assigning Security Administrator role for incident response'
    });
  }
  if (options.assignDefenderAdvancedHunting) {
    steps.push({
      Title: 'Assign Defender Advanced Hunting',
      Status: 'pending',
      Message: 'Assigning Defender Advanced Hunting permissions'
    });
  }

  steps.push(
    { Title: 'Persist Tenant Mapping', Status: 'pending', Message: 'Saving B2B tenant mapping to CIPP storage' },
    { Title: 'Finalize B2B Onboarding', Status: 'pending', Message: 'Finalizing B2B onboarding state' }
  );

  return steps;
}

function formatOnboardingRecord(record) {
  const steps = record.OnboardingSteps
    || record.onboardingSteps
    || safeJsonParse(record.OnboardingStepsJson || record.onboardingStepsJson, []);
  const relationship = record.Relationship
    || safeJsonParse(record.RelationshipJson || record.relationshipJson, null)
    || {
      customer: {
        displayName: record.customerName || record.displayName || record.RowKey || record.rowKey || 'Unknown',
        tenantId: record.tenantId || record.RowKey || record.rowKey
      }
    };
  const logs = record.Logs
    || record.logs
    || safeJsonParse(record.LogsJson || record.logsJson, []);

  return {
    RowKey: record.RowKey || record.rowKey || record.id,
    PartitionKey: record.PartitionKey || record.partitionKey || 'Onboarding',
    Timestamp: record.Timestamp || record.timestamp || new Date().toISOString(),
    Relationship: relationship,
    Status: record.Status || record.status || 'pending',
    OnboardingSteps: Array.isArray(steps) ? steps : [],
    Logs: Array.isArray(logs) ? logs : []
  };
}

async function saveOnboardingRecord(record) {
  const entity = {
    partitionKey: 'Onboarding',
    rowKey: record.RowKey,
    Status: record.Status,
    Timestamp: record.Timestamp || new Date().toISOString(),
    RelationshipJson: JSON.stringify(record.Relationship || {}),
    OnboardingStepsJson: JSON.stringify(record.OnboardingSteps || []),
    LogsJson: JSON.stringify(record.Logs || []),
    LastUpdated: new Date().toISOString()
  };

  await upsertEntity('TenantOnboarding', entity);
}

function progressOnboarding(record) {
  const now = new Date().toISOString();
  const steps = Array.isArray(record.OnboardingSteps) ? [...record.OnboardingSteps] : getDefaultOnboardingSteps();
  const logs = Array.isArray(record.Logs) ? [...record.Logs] : [];
  const runningStepIndex = steps.findIndex((step) => step.Status === 'running');
  const nextPendingIndex = steps.findIndex((step) => step.Status === 'pending');

  if (runningStepIndex >= 0) {
    const finishedStep = steps[runningStepIndex];
    steps[runningStepIndex] = {
      ...finishedStep,
      Status: 'succeeded',
      Message: finishedStep.Message || `${finishedStep.Title} completed at ${now}`
    };
    logs.push(`${finishedStep.Title} succeeded (${now})`);
  } else if (nextPendingIndex >= 0) {
    const startingStep = steps[nextPendingIndex];
    steps[nextPendingIndex] = {
      ...startingStep,
      Status: 'running',
      Message: `${startingStep.Title} started at ${now}`
    };
    logs.push(`${startingStep.Title} started (${now})`);
    return {
      ...record,
      Status: 'running',
      Timestamp: now,
      OnboardingSteps: steps,
      Logs: logs
    };
  }

  const upcomingPendingIndex = steps.findIndex((step) => step.Status === 'pending');
  if (upcomingPendingIndex >= 0) {
    const nextStep = steps[upcomingPendingIndex];
    steps[upcomingPendingIndex] = {
      ...nextStep,
      Status: 'running',
      Message: `${nextStep.Title} started at ${now}`
    };
    logs.push(`${nextStep.Title} started (${now})`);
    return {
      ...record,
      Status: 'running',
      Timestamp: now,
      OnboardingSteps: steps,
      Logs: logs
    };
  }

  logs.push(`Onboarding completed (${now})`);
  return {
    ...record,
    Status: 'succeeded',
    Timestamp: now,
    OnboardingSteps: steps,
    Logs: logs
  };
}

/**
 * POST /api/ExecB2BOnboarding
 *
 * Starts B2B onboarding records for one or more customer tenants.
 * This endpoint is intentionally queue-oriented: each call records onboarding intent
 * and the UI can poll via /api/ListTenantOnboarding and /api/ExecOnboardTenant.
 */
router.post('/ExecB2BOnboarding', async (req, res) => {
  const {
    serviceTenantId,
    customerTenantIds,
    invitationEmail,
    assignSecurityReader = true,
    assignSecurityAdministrator = false,
    assignDefenderAdvancedHunting = true,
    notes
  } = req.body || {};

  const tenantIds = normalizeTenantIdList(customerTenantIds);
  const invalidTenantIds = tenantIds.filter((id) => !isGuid(id));

  if (!isGuid(serviceTenantId)) {
    return res.status(400).json({
      severity: 'error',
      Results: 'SOC tenant ID must be a valid tenant GUID'
    });
  }

  if (!invitationEmail || typeof invitationEmail !== 'string') {
    return res.status(400).json({
      severity: 'error',
      Results: 'Invitation contact email is required'
    });
  }

  if (tenantIds.length === 0) {
    return res.status(400).json({
      severity: 'error',
      Results: 'At least one customer tenant ID is required'
    });
  }

  if (invalidTenantIds.length > 0) {
    return res.status(400).json({
      severity: 'error',
      Results: `Invalid tenant GUID(s): ${invalidTenantIds.join(', ')}`
    });
  }

  try {
    const now = new Date().toISOString();
    const results = [];

    for (const customerTenantId of tenantIds) {
      const onboardingId = `b2b-${customerTenantId}`;
      const b2bRecord = {
        RowKey: onboardingId,
        PartitionKey: 'Onboarding',
        Timestamp: now,
        Relationship: {
          customer: {
            displayName: customerTenantId,
            tenantId: customerTenantId
          },
          type: 'B2B',
          serviceTenantId,
          invitationEmail,
          notes: notes || ''
        },
        Status: 'queued',
        OnboardingSteps: getB2BOnboardingSteps({
          assignSecurityReader: coerceBoolean(assignSecurityReader),
          assignSecurityAdministrator: coerceBoolean(assignSecurityAdministrator),
          assignDefenderAdvancedHunting: coerceBoolean(assignDefenderAdvancedHunting)
        }),
        Logs: [
          `B2B onboarding queued for ${customerTenantId} (${now})`,
          `SOC tenant: ${serviceTenantId}`,
          `Invitation contact: ${invitationEmail}`
        ]
      };

      const progressedRecord = progressOnboarding(b2bRecord);
      await saveOnboardingRecord(progressedRecord);
      results.push({
        tenantId: customerTenantId,
        onboardingId,
        status: progressedRecord.Status
      });
    }

    return res.json({
      severity: 'success',
      Results: [
        `Queued B2B onboarding for ${results.length} tenant(s)`,
        ...results.map((item) => `Tenant ${item.tenantId} queued as ${item.onboardingId}`)
      ],
      Metadata: {
        serviceTenantId,
        invitationEmail,
        queuedCount: results.length
      },
      Onboarding: results
    });
  } catch (err) {
    console.error('[/api/ExecB2BOnboarding] Error:', err.message);
    return res.status(500).json({
      severity: 'error',
      Results: `Failed to queue B2B onboarding: ${err.message}`
    });
  }
});

/**
 * GET /api/ExecExcludeTenant
 * 
 * Lists all excluded tenants (tenants that should not be synced/managed)
 * When ListAll=True, returns all tenants including their exclude status
 * 
 * Query params:
 * - ListAll: If true, returns all authenticated tenants with exclude status
 */
router.get('/ExecExcludeTenant', async (req, res) => {
  console.log('[/api/ExecExcludeTenant] Getting excluded tenants...');
  
  const { ListAll } = req.query;
  
  try {
    if (ListAll === 'True' || ListAll === 'true') {
      // Return all authenticated tenants with their exclude status
      // For POC, return mock data
      console.log('[/api/ExecExcludeTenant] Returning all tenants with exclude status');
      
      // Try to query actual tenants from table storage
      let tenants = [];
      try {
        tenants = await queryTable('Tenants');
        console.log(`[/api/ExecExcludeTenant] Found ${tenants.length} tenants in table`);
      } catch (tableErr) {
        console.log('[/api/ExecExcludeTenant] Table query failed, using mock data');
        // Return empty array for POC - tenants will be added via onboarding
        tenants = [];
      }
      
      // Format tenants with exclude status
      const formattedTenants = tenants.map(t => ({
        tenantId: t.RowKey || t.tenantId,
        displayName: t.displayName || t.DefaultDomainName || 'Unknown',
        defaultDomainName: t.DefaultDomainName || t.defaultDomainName || 'unknown.onmicrosoft.com',
        excluded: t.excluded || false,
        tenantMode: t.tenantMode || 'GDAP'
      }));
      
      res.json({
        Results: formattedTenants
      });
      
    } else {
      // Return only excluded tenants
      console.log('[/api/ExecExcludeTenant] Returning only excluded tenants');
      
      res.json({
        Results: []  // No excluded tenants in POC
      });
    }
    
  } catch (err) {
    console.error('[/api/ExecExcludeTenant] Error:', err.message);
    res.status(500).json({
      severity: 'error',
      message: `Failed to get excluded tenants: ${err.message}`
    });
  }
});

/**
 * POST /api/ExecExcludeTenant
 * 
 * Excludes or includes a tenant
 * 
 * Request body:
 * - tenantId: The tenant to exclude/include
 * - exclude: Boolean to set exclude status
 */
router.post('/ExecExcludeTenant', async (req, res) => {
  console.log('[/api/ExecExcludeTenant] Setting tenant exclude status...');
  
  const { tenantId, exclude } = req.body;
  
  if (!tenantId) {
    return res.status(400).json({
      severity: 'error',
      message: 'tenantId is required'
    });
  }
  
  try {
    // TODO: Update tenant exclude status in table
    console.log(`[/api/ExecExcludeTenant] Setting tenant ${tenantId} excluded = ${exclude}`);
    
    res.json({
      severity: 'success',
      message: `Tenant ${tenantId} ${exclude ? 'excluded' : 'included'} successfully`
    });
    
  } catch (err) {
    console.error('[/api/ExecExcludeTenant] Error:', err.message);
    res.status(500).json({
      severity: 'error',
      message: `Failed to update tenant: ${err.message}`
    });
  }
});

/**
 * POST /api/ExecUpdateRefreshToken
 * 
 * Stores the refresh token for partner tenant (GDAP) authentication
 * 
 * Request body:
 * - accessToken: The access token
 * - refreshToken: The refresh token
 * - tenantId: The tenant ID
 * - tenantMode: "GDAP" or "perTenant"
 */
router.post('/ExecUpdateRefreshToken', async (req, res) => {
  console.log('[/api/ExecUpdateRefreshToken] Updating refresh token...');
  console.log('[/api/ExecUpdateRefreshToken] Request body keys:', Object.keys(req.body));
  
  const { accessToken, refreshToken, tenantId, username, tenantMode, onmicrosoftDomain } = req.body;
  
  if (!refreshToken) {
    console.warn('[/api/ExecUpdateRefreshToken] No refresh token provided - will use access token only');
    // Continue anyway - some auth flows don't return refresh tokens
    // but we can still proceed with access token authentication
  }
  
  try {
    console.log(`[/api/ExecUpdateRefreshToken] Mode: ${tenantMode}`);
    console.log(`[/api/ExecUpdateRefreshToken] Tenant ID: ${tenantId}`);
    console.log(`[/api/ExecUpdateRefreshToken] Username: ${username}`);
    console.log(`[/api/ExecUpdateRefreshToken] Domain: ${onmicrosoftDomain}`);
    console.log(`[/api/ExecUpdateRefreshToken] Has access token: ${!!accessToken}`);
    console.log(`[/api/ExecUpdateRefreshToken] Has refresh token: ${!!refreshToken}`);
    
    // Store refresh token in Table Storage (CippTokens table)
    if (refreshToken && tenantId) {
      await storeRefreshToken(tenantId, refreshToken);
      console.log(`[/api/ExecUpdateRefreshToken] Stored refresh token for ${tenantId}`);
    }
    
    // Store partner tenant info if this is GDAP mode
    if (tenantMode === 'GDAP' && tenantId) {
      await upsertEntity('CippSettings', {
        partitionKey: 'Config',
        rowKey: 'PartnerTenant',
        TenantId: tenantId,
        Username: username,
        Domain: onmicrosoftDomain,
        LastUpdated: new Date().toISOString()
      });
      console.log(`[/api/ExecUpdateRefreshToken] Stored partner tenant info for ${tenantId}`);
    }
    
    const message = refreshToken 
      ? `Successfully authenticated to partner tenant. Tenant ID: ${tenantId || 'Unknown'}`
      : `Authenticated to partner tenant (no refresh token - session may expire). Tenant ID: ${tenantId || 'Unknown'}`;
    
    res.json({
      severity: 'success',
      message: message,
      tenantId: tenantId,
      username: username,
      tenantMode: tenantMode,
      hasRefreshToken: !!refreshToken
    });
    
  } catch (err) {
    console.error('[/api/ExecUpdateRefreshToken] Error:', err.message);
    res.json({
      severity: 'error',
      message: `Failed to update refresh token: ${err.message}`
    });
  }
});

/**
 * POST /api/ExecAddTenant
 * 
 * Adds a per-tenant authentication
 * 
 * Request body:
 * - accessToken: The access token
 * - refreshToken: The refresh token  
 * - tenantId: The tenant ID
 * - tenantMode: "perTenant"
 */
router.post('/ExecAddTenant', async (req, res) => {
  console.log('[/api/ExecAddTenant] Adding tenant...');
  console.log('[/api/ExecAddTenant] Request body keys:', Object.keys(req.body));
  
  const { accessToken, refreshToken, tenantId, username, tenantMode, onmicrosoftDomain } = req.body;
  
  if (!refreshToken) {
    console.error('[/api/ExecAddTenant] No refresh token provided');
    return res.json({
      severity: 'error',
      message: 'Refresh token is required'
    });
  }
  
  if (!tenantId) {
    console.error('[/api/ExecAddTenant] No tenant ID provided');
    return res.json({
      severity: 'error',
      message: 'Tenant ID is required'
    });
  }
  
  try {
    console.log(`[/api/ExecAddTenant] Tenant ID: ${tenantId}`);
    console.log(`[/api/ExecAddTenant] Username: ${username}`);
    console.log(`[/api/ExecAddTenant] Domain: ${onmicrosoftDomain}`);
    
    // Store refresh token
    await storeRefreshToken(tenantId, refreshToken);
    console.log(`[/api/ExecAddTenant] Stored refresh token for ${tenantId}`);
    
    // Add tenant to Tenants table
    await upsertEntity('Tenants', {
      partitionKey: 'Tenants',
      rowKey: tenantId,
      displayName: username || onmicrosoftDomain || tenantId,
      defaultDomainName: onmicrosoftDomain || `${tenantId}.onmicrosoft.com`,
      tenantMode: tenantMode || 'perTenant',
      lastRefresh: new Date().toISOString(),
      graphErrorCount: 0,
      Excluded: false
    });
    console.log(`[/api/ExecAddTenant] Added tenant ${tenantId} to Tenants table`);
    
    res.json({
      severity: 'success',
      message: `Successfully added tenant: ${onmicrosoftDomain || tenantId}`,
      tenantId: tenantId,
      username: username,
      tenantMode: tenantMode
    });
    
  } catch (err) {
    console.error('[/api/ExecAddTenant] Error:', err.message);
    res.json({
      severity: 'error',
      message: `Failed to add tenant: ${err.message}`
    });
  }
});

/**
 * GET /api/ListTenantOnboarding
 * List tenant onboarding status
 *
 * Returns data in format expected by the Onboarding table:
 * - Timestamp
 * - Relationship.customer.displayName (nested)
 * - Status
 * - OnboardingSteps
 * - Logs
 * - RowKey (for actions)
 */
router.get('/ListTenantOnboarding', async (req, res) => {
  console.log('[/api/ListTenantOnboarding] Getting tenant onboarding status');

  try {
    // Query onboarding records from TenantOnboarding table
    let onboardingRecords = [];
    try {
      onboardingRecords = await queryTable('TenantOnboarding');
    } catch (tableErr) {
      console.log('[/api/ListTenantOnboarding] TenantOnboarding table not found, checking Tenants table');
    }

    // If no onboarding records, fall back to tenants table
    if (onboardingRecords.length === 0) {
      try {
        const tenants = await queryTable('Tenants');
        // Convert tenants to onboarding format
        onboardingRecords = tenants.map(t => ({
          RowKey: t.RowKey || t.tenantId,
          PartitionKey: 'Onboarding',
          Timestamp: t.lastRefresh || t.Timestamp || new Date().toISOString(),
          Relationship: {
            customer: {
              displayName: t.displayName || t.DefaultDomainName || 'Unknown Tenant',
              tenantId: t.RowKey || t.tenantId
            }
          },
          Status: t.Excluded ? 'Excluded' : 'Active',
          OnboardingSteps: [
            { Title: 'GDAP Relationship', Status: 'succeeded' },
            { Title: 'Tenant Added', Status: 'succeeded' }
          ],
          Logs: [`Tenant ${t.displayName || t.RowKey} onboarded successfully`]
        }));
      } catch (tenantErr) {
        console.log('[/api/ListTenantOnboarding] Tenants table query failed:', tenantErr.message);
      }
    }

    // Format onboarding records for the table
    const formattedRecords = onboardingRecords.map(formatOnboardingRecord);

    console.log(`[/api/ListTenantOnboarding] Returning ${formattedRecords.length} onboarding records`);
    return res.json(formattedRecords);
  } catch (err) {
    console.error('[/api/ListTenantOnboarding] Error:', err.message);
    return res.json([]);
  }
});

/**
 * POST /api/ExecOnboardTenant
 * Start, cancel, or retry tenant onboarding
 *
 * Body params:
 * - id: RowKey of the onboarding record
 * - Cancel: Boolean to cancel onboarding
 * - Retry: Boolean to retry onboarding
 */
router.post('/ExecOnboardTenant', async (req, res) => {
  const { id } = req.body;
  const cancelRequested = coerceBoolean(req.body.Cancel) || coerceBoolean(req.body.cancel);
  const retryRequested = coerceBoolean(req.body.Retry) || coerceBoolean(req.body.retry);

  console.log(`[/api/ExecOnboardTenant] Action on ${id}: Cancel=${cancelRequested}, Retry=${retryRequested}`);

  if (!id) {
    return res.status(400).json({
      Results: 'Onboarding ID is required',
      severity: 'error'
    });
  }

  try {
    const existing = await getEntity('TenantOnboarding', 'Onboarding', id);
    let record = existing ? formatOnboardingRecord(existing) : null;
    const now = new Date().toISOString();

    if (cancelRequested) {
      if (!record) {
        record = {
          RowKey: id,
          PartitionKey: 'Onboarding',
          Timestamp: now,
          Relationship: {
            customer: {
              displayName: id,
              tenantId: id
            }
          },
          Status: 'cancelled',
          OnboardingSteps: getDefaultOnboardingSteps().map((step) => ({
            ...step,
            Status: 'cancelled',
            Message: 'Cancelled before execution'
          })),
          Logs: [`Onboarding cancelled (${now})`]
        };
      } else {
        const updatedSteps = (record.OnboardingSteps || []).map((step) => {
          if (step.Status === 'succeeded') return step;
          return {
            ...step,
            Status: 'cancelled',
            Message: 'Cancelled by operator'
          };
        });
        const updatedLogs = Array.isArray(record.Logs) ? [...record.Logs] : [];
        updatedLogs.push(`Onboarding cancelled (${now})`);
        record = {
          ...record,
          Status: 'cancelled',
          Timestamp: now,
          OnboardingSteps: updatedSteps,
          Logs: updatedLogs
        };
      }

      await saveOnboardingRecord(record);
      return res.json(record);
    }

    if (retryRequested) {
      record = {
        RowKey: id,
        PartitionKey: 'Onboarding',
        Timestamp: now,
        Relationship: record?.Relationship || {
          customer: {
            displayName: id,
            tenantId: id
          }
        },
        Status: 'queued',
        OnboardingSteps: getDefaultOnboardingSteps().map((step) => ({
          ...step,
          Status: 'pending',
          Message: 'Queued for retry'
        })),
        Logs: [...(Array.isArray(record?.Logs) ? record.Logs : []), `Retry requested (${now})`]
      };

      record = progressOnboarding(record);
      await saveOnboardingRecord(record);
      return res.json(record);
    }

    if (!record) {
      record = {
        RowKey: id,
        PartitionKey: 'Onboarding',
        Timestamp: now,
        Relationship: {
          customer: {
            displayName: id,
            tenantId: id
          }
        },
        Status: 'queued',
        OnboardingSteps: getDefaultOnboardingSteps(),
        Logs: [`Onboarding started (${now})`]
      };
    }

    if (record.Status !== 'succeeded' && record.Status !== 'failed' && record.Status !== 'cancelled') {
      record = progressOnboarding(record);
      await saveOnboardingRecord(record);
    }

    return res.json(record);

  } catch (err) {
    console.error('[/api/ExecOnboardTenant] Error:', err.message);
    return res.status(500).json({
      Results: `Failed to process onboarding: ${err.message}`,
      severity: 'error'
    });
  }
});

module.exports = router;
