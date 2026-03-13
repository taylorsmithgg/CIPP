const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getSAMCredentials, getCloudEndpoints, normalizeTenantId } = require('../utils/tokenManager');

/**
 * Azure Virtual Desktop (AVD) Management Endpoints
 *
 * These endpoints use the Azure Resource Manager API (not Graph API)
 * API Provider: Microsoft.DesktopVirtualization
 * API Version: 2024-04-03
 */

const AVD_API_VERSION = '2024-04-03';
const COMPUTE_API_VERSION = '2024-03-01';
const NETWORK_API_VERSION = '2023-09-01';
const RESOURCE_API_VERSION = '2022-09-01';
const PROVIDER_API_VERSION = '2021-04-01';
const GALLERY_API_VERSION = '2023-07-03';

const AVD_WORKFLOW_STAGES = [
  'PrepareEnvironment',
  'CreateBaseVm',
  'HardenBaseVm',
  'SysprepAndCapture',
  'CreateHostPool',
  'DeploySessionHosts',
  'Validate'
];

const ALWAYS_REQUIRED_WORKFLOW_FIELDS = ['subscriptionId', 'location'];

const WORKFLOW_STAGE_REQUIREMENTS = {
  PrepareEnvironment: ['imageResourceGroup', 'hostPoolResourceGroup'],
  CreateBaseVm: [
    'imageResourceGroup',
    'baseVmName',
    'vnetResourceGroup',
    'vnetName',
    'sessionHostSubnetName',
    'localAdminUsername',
    'localAdminPassword'
  ],
  HardenBaseVm: [],
  SysprepAndCapture: [
    'imageResourceGroup',
    'baseVmName',
    'galleryName',
    'galleryImageDefinitionName',
    'galleryImageVersion'
  ],
  CreateHostPool: [
    'hostPoolResourceGroup',
    'hostPoolName',
    'workspaceName',
    'desktopAppGroupName'
  ],
  DeploySessionHosts: [
    'vnetResourceGroup',
    'vnetName',
    'sessionHostSubnetName',
    'localAdminUsername',
    'localAdminPassword',
    'imageResourceGroup',
    'galleryName',
    'galleryImageDefinitionName',
    'galleryImageVersion',
    'hostPoolResourceGroup',
    'hostPoolName'
  ],
  Validate: [
    'imageResourceGroup',
    'galleryName',
    'galleryImageDefinitionName',
    'galleryImageVersion',
    'hostPoolResourceGroup',
    'hostPoolName'
  ]
};

const AVD_DSC_MODULES_ZIP = 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.02714.342.zip';

/**
 * Get Azure Management endpoint based on cloud environment
 */
function getAzureManagementEndpoint() {
  const cloud = process.env.AZURE_CLOUD || 'Commercial';

  const endpoints = {
    'Commercial': 'https://management.azure.com',
    'GCCH': 'https://management.usgovcloudapi.net',
    'DoD': 'https://management.usgovcloudapi.net',
    'China': 'https://management.chinacloudapi.cn'
  };

  return endpoints[cloud] || endpoints['Commercial'];
}

function resolveTenantFilterFromReq(req) {
  return (
    req?.query?.tenantFilter
    || req?.query?.TenantFilter
    || req?.body?.tenantFilter
    || req?.body?.TenantFilter
    || null
  );
}

function getTokenTenantId(accessToken) {
  try {
    const payloadBase64 = accessToken.split('.')[1];
    const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    return payload?.tid || null;
  } catch (_) {
    return null;
  }
}

async function getSubscriptionTenantId(subscriptionId, accessToken, managementEndpoint) {
  const url = `${managementEndpoint}/subscriptions/${subscriptionId}?api-version=2022-12-01`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data?.tenantId || null;
}

/**
 * Get access token for Azure Resource Manager
 */
async function getArmAccessToken(requestedTenant = null) {
  const cloud = process.env.AZURE_CLOUD || 'Commercial';

  const scopes = {
    'Commercial': 'https://management.azure.com/.default',
    'GCCH': 'https://management.usgovcloudapi.net/.default',
    'DoD': 'https://management.usgovcloudapi.net/.default',
    'China': 'https://management.chinacloudapi.cn/.default'
  };

  const scope = scopes[cloud] || scopes['Commercial'];
  const samCreds = await getSAMCredentials();
  const rawRequestedTenant =
    typeof requestedTenant === 'string' ? requestedTenant.trim() : requestedTenant;

  if (!rawRequestedTenant || rawRequestedTenant === 'AllTenants') {
    throw new Error('tenantFilter is required for AVD ARM operations');
  }

  const normalizedTenant = await normalizeTenantId(rawRequestedTenant);
  const tokenTenantId = normalizedTenant || rawRequestedTenant;

  if (!tokenTenantId) {
    throw new Error('SAM tenant ID is not configured for ARM token acquisition');
  }

  if (!samCreds?.clientId || !samCreds?.clientSecret) {
    throw new Error('SAM client credentials are not configured for ARM token acquisition');
  }

  const authority = getCloudEndpoints().authority;
  const tokenUrl = `${authority}/${tokenTenantId}/oauth2/v2.0/token`;

  console.log(`[/api/AVD] ARM token tenant requested: ${rawRequestedTenant || 'none'}, resolved: ${tokenTenantId}`);

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      client_id: samCreds.clientId,
      client_secret: samCreds.clientSecret,
      scope,
      grant_type: 'client_credentials'
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const accessToken = response.data.access_token;
  const issuedTenantId = getTokenTenantId(accessToken);

  if (issuedTenantId && normalizedTenant && /^[0-9a-f-]{36}$/i.test(normalizedTenant) && issuedTenantId !== normalizedTenant) {
    throw new Error(
      `Tenant token mismatch: requested ${normalizedTenant}, but token was issued for ${issuedTenantId}`
    );
  }

  return accessToken;
}

function isNotFoundError(error) {
  return error?.response?.status === 404;
}

function isConflictError(error) {
  return error?.response?.status === 409;
}

function toSelectionOption(value, label, extra = {}) {
  return {
    value,
    label,
    ...extra
  };
}

function sanitizeWorkflowStage(stage) {
  if (typeof stage !== 'string') {
    return null;
  }

  const normalized = stage.trim().toLowerCase();
  const match = AVD_WORKFLOW_STAGES.find((known) => known.toLowerCase() === normalized);
  return match || null;
}

function resolveWorkflowStages(stages) {
  const input = Array.isArray(stages) ? stages : (stages ? [stages] : ['All']);
  const normalized = input
    .map((stage) => (typeof stage === 'string' ? stage.trim() : ''))
    .filter(Boolean);

  if (normalized.length === 0 || normalized.some((stage) => stage.toLowerCase() === 'all')) {
    return [...AVD_WORKFLOW_STAGES];
  }

  const resolved = normalized.map(sanitizeWorkflowStage);
  const invalid = normalized.filter((stage, idx) => !resolved[idx]);

  if (invalid.length > 0) {
    const error = new Error(`Invalid stage(s): ${invalid.join(', ')}`);
    error.code = 'InvalidStages';
    throw error;
  }

  return [...new Set(resolved)];
}

function isEmptyValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalizeWorkflowConfig(config = {}) {
  return {
    subscriptionId: config.subscriptionId ?? config.SubscriptionId ?? '',
    tenantId: config.tenantId ?? config.TenantId ?? '',
    location: config.location ?? config.Location ?? 'usgovvirginia',
    imageResourceGroup: config.imageResourceGroup ?? config.ImageResourceGroup ?? '',
    hostPoolResourceGroup: config.hostPoolResourceGroup ?? config.HostPoolResourceGroup ?? '',
    vnetResourceGroup: config.vnetResourceGroup ?? config.VnetResourceGroup ?? '',
    vnetName: config.vnetName ?? config.VnetName ?? '',
    sessionHostSubnetName: config.sessionHostSubnetName ?? config.SessionHostSubnetName ?? '',
    baseVmName: config.baseVmName ?? config.BaseVmName ?? 'avd-gold-base-01',
    localAdminUsername: config.localAdminUsername ?? config.LocalAdminUsername ?? 'avdadmin',
    localAdminPassword: config.localAdminPassword ?? config.LocalAdminPassword ?? config.localAdminPasswordPlaintext ?? config.LocalAdminPasswordPlaintext ?? '',
    baseVmSize: config.baseVmSize ?? config.BaseVmSize ?? 'Standard_D4ds_v5',
    baseImagePublisher: config.baseImagePublisher ?? config.BaseImagePublisher ?? 'MicrosoftWindowsDesktop',
    baseImageOffer: config.baseImageOffer ?? config.BaseImageOffer ?? 'Windows-11',
    baseImageSku: config.baseImageSku ?? config.BaseImageSku ?? 'win11-23h2-avd',
    baseImageVersion: config.baseImageVersion ?? config.BaseImageVersion ?? 'latest',
    galleryName: config.galleryName ?? config.GalleryName ?? 'sig-avd-gold',
    galleryImageDefinitionName: config.galleryImageDefinitionName ?? config.GalleryImageDefinitionName ?? 'avd-gold-base',
    galleryImageVersion: config.galleryImageVersion ?? config.GalleryImageVersion ?? '1.0.0',
    hostPoolName: config.hostPoolName ?? config.HostPoolName ?? 'avd-cui-hp',
    workspaceName: config.workspaceName ?? config.WorkspaceName ?? 'avd-cui-ws',
    desktopAppGroupName: config.desktopAppGroupName ?? config.DesktopAppGroupName ?? 'avd-cui-dag',
    remoteAppGroupName: config.remoteAppGroupName ?? config.RemoteAppGroupName ?? '',
    maxSessionLimit: Number(config.maxSessionLimit ?? config.MaxSessionLimit ?? 10),
    sessionHostCount: Number(config.sessionHostCount ?? config.SessionHostCount ?? 2),
    sessionHostNamePrefix: config.sessionHostNamePrefix ?? config.SessionHostNamePrefix ?? 'avdcui-sh',
    sessionHostVmSize: config.sessionHostVmSize ?? config.SessionHostVmSize ?? 'Standard_D4ds_v5',
    fslogixProfilePath: config.fslogixProfilePath ?? config.FslogixProfilePath ?? '',
    fslogixIncludeGroup: config.fslogixIncludeGroup ?? config.FslogixIncludeGroup ?? 'DOMAIN\\FSLogixUsers',
    avdUsersGroupObjectId: config.avdUsersGroupObjectId ?? config.AvdUsersGroupObjectId ?? '',
    avdAdminsGroupObjectId: config.avdAdminsGroupObjectId ?? config.AvdAdminsGroupObjectId ?? ''
  };
}

function buildWorkflowFieldSelection(options, fieldName, configuredValue, fallbackValue = '') {
  if (!Array.isArray(options) || options.length === 0) {
    return {
      value: isEmptyValue(configuredValue) ? fallbackValue : configuredValue,
      needsSelection: false
    };
  }

  const byValue = options.find((option) => option.value === configuredValue);
  if (!isEmptyValue(configuredValue) && byValue) {
    return { value: configuredValue, needsSelection: false };
  }

  if (!isEmptyValue(configuredValue) && !byValue) {
    return { value: configuredValue, needsSelection: false };
  }

  if (!isEmptyValue(fallbackValue)) {
    const byFallback = options.find((option) => option.value === fallbackValue);
    if (byFallback) {
      return { value: fallbackValue, needsSelection: false };
    }
  }

  if (options.length === 1) {
    return { value: options[0].value, needsSelection: false };
  }

  return {
    value: '',
    needsSelection: true,
    missingField: fieldName
  };
}

async function armGet(url, accessToken) {
  return axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
}

async function armPost(url, payload, accessToken) {
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
}

async function armPut(url, payload, accessToken) {
  return axios.put(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
}

async function armPatch(url, payload, accessToken) {
  return axios.patch(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
}

async function armGetIfExists(url, accessToken) {
  try {
    const response = await armGet(url, accessToken);
    return response.data;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function getBaseVmImageReference(config) {
  return {
    publisher: config.baseImagePublisher,
    offer: config.baseImageOffer,
    sku: config.baseImageSku,
    version: config.baseImageVersion
  };
}

function buildHardeningScript(config) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent /v DisableWindowsConsumerFeatures /t REG_DWORD /d 1 /f',
    '$appxToRemove = @("Microsoft.Xbox*", "Microsoft.Bing*", "Microsoft.GetHelp", "Microsoft.Getstarted", "Microsoft.People")',
    'foreach ($pattern in $appxToRemove) {',
    '  Get-AppxProvisionedPackage -Online | Where-Object DisplayName -like $pattern | ForEach-Object {',
    '    try { Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName -ErrorAction Stop | Out-Null } catch {}',
    '  }',
    '}'
  ];

  if (!isEmptyValue(config.fslogixProfilePath)) {
    const escapedProfilePath = String(config.fslogixProfilePath).replace(/"/g, '\\"');
    const escapedIncludeGroup = String(config.fslogixIncludeGroup || '').replace(/"/g, '\\"');
    script.push(
      'New-Item -Path "HKLM:\\SOFTWARE\\FSLogix\\Profiles" -Force | Out-Null',
      'New-ItemProperty -Path "HKLM:\\SOFTWARE\\FSLogix\\Profiles" -Name Enabled -Value 1 -PropertyType DWord -Force | Out-Null',
      'New-ItemProperty -Path "HKLM:\\SOFTWARE\\FSLogix\\Profiles" -Name PreventLoginWithFailure -Value 1 -PropertyType DWord -Force | Out-Null',
      `New-ItemProperty -Path "HKLM:\\SOFTWARE\\FSLogix\\Profiles" -Name VHDLocations -Value "${escapedProfilePath}" -PropertyType MultiString -Force | Out-Null`,
      `New-ItemProperty -Path "HKLM:\\SOFTWARE\\FSLogix\\Profiles" -Name IncludeGroups -Value "${escapedIncludeGroup}" -PropertyType MultiString -Force | Out-Null`
    );
  }

  return script;
}

function getVmPowerState(vmStatusResponse) {
  const statuses = vmStatusResponse?.statuses || [];
  const powerStatus = statuses.find((status) => typeof status.code === 'string' && status.code.startsWith('PowerState/'));
  return powerStatus?.code || null;
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listSubscriptionsForTenant(accessToken, managementEndpoint, expectedTenantId = null) {
  const url = `${managementEndpoint}/subscriptions?api-version=2022-12-01`;
  const response = await armGet(url, accessToken);
  let subscriptions = response.data.value || [];
  subscriptions = subscriptions.filter((sub) => sub.state === 'Enabled');

  if (expectedTenantId) {
    subscriptions = subscriptions.filter((sub) => sub.tenantId === expectedTenantId);
  }

  return subscriptions;
}

async function listResourceGroupsForSubscription(subscriptionId, accessToken, managementEndpoint) {
  const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourcegroups?api-version=${RESOURCE_API_VERSION}`;
  const response = await armGet(url, accessToken);
  return response.data.value || [];
}

async function listVnetsForResourceGroup(subscriptionId, resourceGroup, accessToken, managementEndpoint) {
  const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/virtualNetworks?api-version=${NETWORK_API_VERSION}`;
  const response = await armGet(url, accessToken);
  return response.data.value || [];
}

async function listGalleriesForResourceGroup(subscriptionId, resourceGroup, accessToken, managementEndpoint) {
  const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/galleries?api-version=${GALLERY_API_VERSION}`;
  const response = await armGet(url, accessToken);
  return response.data.value || [];
}

async function listGalleryDefinitions(subscriptionId, resourceGroup, galleryName, accessToken, managementEndpoint) {
  const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/galleries/${galleryName}/images?api-version=${GALLERY_API_VERSION}`;
  const response = await armGet(url, accessToken);
  return response.data.value || [];
}

async function listAvdResources(resourceType, subscriptionId, resourceGroup, accessToken, managementEndpoint) {
  const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/${resourceType}?api-version=${AVD_API_VERSION}`;
  const response = await armGet(url, accessToken);
  return response.data.value || [];
}

async function resolveAvdWorkflowConfiguration({
  partialConfig = {},
  stages = ['All'],
  accessToken,
  managementEndpoint,
  expectedTenantId = null
}) {
  const effectiveStages = resolveWorkflowStages(stages);
  const resolvedConfig = normalizeWorkflowConfig(partialConfig);
  const options = {};
  const warnings = [];
  const missingSelections = [];

  const subscriptions = await listSubscriptionsForTenant(accessToken, managementEndpoint, expectedTenantId);
  options.subscriptions = subscriptions.map((sub) => toSelectionOption(
    sub.subscriptionId,
    `${sub.displayName} (${sub.subscriptionId.substring(0, 8)}...)`,
    { tenantId: sub.tenantId, displayName: sub.displayName }
  ));

  const subscriptionSelection = buildWorkflowFieldSelection(
    options.subscriptions,
    'subscriptionId',
    resolvedConfig.subscriptionId,
    ''
  );

  if (subscriptionSelection.needsSelection) {
    missingSelections.push(subscriptionSelection.missingField);
  } else {
    resolvedConfig.subscriptionId = subscriptionSelection.value;
  }

  if (!isEmptyValue(resolvedConfig.subscriptionId) && subscriptions.length > 0) {
    const selectedSub = subscriptions.find((sub) => sub.subscriptionId === resolvedConfig.subscriptionId);
    if (!selectedSub) {
      warnings.push(`Configured subscriptionId '${resolvedConfig.subscriptionId}' is not visible to the SAM app.`);
    } else if (isEmptyValue(resolvedConfig.tenantId)) {
      resolvedConfig.tenantId = selectedSub.tenantId;
    }
  }

  if (isEmptyValue(resolvedConfig.subscriptionId)) {
    return { resolvedConfig, options, missingSelections, warnings, effectiveStages };
  }

  let resourceGroups = [];
  try {
    resourceGroups = await listResourceGroupsForSubscription(resolvedConfig.subscriptionId, accessToken, managementEndpoint);
  } catch (error) {
    warnings.push(`Failed to enumerate resource groups for subscription ${resolvedConfig.subscriptionId}: ${error.response?.data?.error?.message || error.message}`);
  }

  options.resourceGroups = resourceGroups.map((rg) => toSelectionOption(
    rg.name,
    `${rg.name} (${rg.location})`,
    { location: rg.location }
  ));

  const imageRgSelection = buildWorkflowFieldSelection(options.resourceGroups, 'imageResourceGroup', resolvedConfig.imageResourceGroup, '');
  if (imageRgSelection.needsSelection) {
    missingSelections.push(imageRgSelection.missingField);
  } else {
    resolvedConfig.imageResourceGroup = imageRgSelection.value;
  }

  const hostPoolRgSelection = buildWorkflowFieldSelection(options.resourceGroups, 'hostPoolResourceGroup', resolvedConfig.hostPoolResourceGroup, '');
  if (hostPoolRgSelection.needsSelection) {
    missingSelections.push(hostPoolRgSelection.missingField);
  } else {
    resolvedConfig.hostPoolResourceGroup = hostPoolRgSelection.value;
  }

  const vnetRgSelection = buildWorkflowFieldSelection(options.resourceGroups, 'vnetResourceGroup', resolvedConfig.vnetResourceGroup, '');
  if (vnetRgSelection.needsSelection) {
    missingSelections.push(vnetRgSelection.missingField);
  } else {
    resolvedConfig.vnetResourceGroup = vnetRgSelection.value;
  }

  if (!isEmptyValue(resolvedConfig.vnetResourceGroup)) {
    let vnets = [];
    try {
      vnets = await listVnetsForResourceGroup(resolvedConfig.subscriptionId, resolvedConfig.vnetResourceGroup, accessToken, managementEndpoint);
    } catch (error) {
      warnings.push(`Failed to enumerate VNets for resource group ${resolvedConfig.vnetResourceGroup}: ${error.response?.data?.error?.message || error.message}`);
    }

    options.vnets = vnets.map((vnet) => toSelectionOption(vnet.name, `${vnet.name} (${vnet.location})`));
    const vnetSelection = buildWorkflowFieldSelection(options.vnets, 'vnetName', resolvedConfig.vnetName, '');
    if (vnetSelection.needsSelection) {
      missingSelections.push(vnetSelection.missingField);
    } else {
      resolvedConfig.vnetName = vnetSelection.value;
    }

    const selectedVnet = vnets.find((vnet) => vnet.name === resolvedConfig.vnetName);
    const subnets = selectedVnet?.properties?.subnets || [];
    options.sessionHostSubnets = subnets.map((subnet) => toSelectionOption(
      subnet.name,
      `${subnet.name} (${subnet.properties?.addressPrefix || 'n/a'})`
    ));

    const subnetSelection = buildWorkflowFieldSelection(
      options.sessionHostSubnets,
      'sessionHostSubnetName',
      resolvedConfig.sessionHostSubnetName,
      ''
    );
    if (subnetSelection.needsSelection) {
      missingSelections.push(subnetSelection.missingField);
    } else {
      resolvedConfig.sessionHostSubnetName = subnetSelection.value;
    }
  } else {
    options.vnets = [];
    options.sessionHostSubnets = [];
  }

  if (!isEmptyValue(resolvedConfig.imageResourceGroup)) {
    let galleries = [];
    try {
      galleries = await listGalleriesForResourceGroup(resolvedConfig.subscriptionId, resolvedConfig.imageResourceGroup, accessToken, managementEndpoint);
    } catch (error) {
      warnings.push(`Failed to enumerate galleries for resource group ${resolvedConfig.imageResourceGroup}: ${error.response?.data?.error?.message || error.message}`);
    }

    options.galleries = galleries.map((gallery) => toSelectionOption(gallery.name, `${gallery.name} (${gallery.location})`));
    const gallerySelection = buildWorkflowFieldSelection(options.galleries, 'galleryName', resolvedConfig.galleryName, '');
    if (gallerySelection.needsSelection) {
      missingSelections.push(gallerySelection.missingField);
    } else {
      resolvedConfig.galleryName = gallerySelection.value;
    }

    if (!isEmptyValue(resolvedConfig.galleryName)) {
      let definitions = [];
      try {
        definitions = await listGalleryDefinitions(
          resolvedConfig.subscriptionId,
          resolvedConfig.imageResourceGroup,
          resolvedConfig.galleryName,
          accessToken,
          managementEndpoint
        );
      } catch (error) {
        if (!isNotFoundError(error)) {
          warnings.push(`Failed to enumerate gallery image definitions for ${resolvedConfig.galleryName}: ${error.response?.data?.error?.message || error.message}`);
        }
      }

      options.galleryImageDefinitions = definitions.map((def) => toSelectionOption(
        def.name,
        `${def.name} (${def.properties?.identifier?.publisher || 'n/a'}/${def.properties?.identifier?.offer || 'n/a'}/${def.properties?.identifier?.sku || 'n/a'})`
      ));

      const imageDefSelection = buildWorkflowFieldSelection(
        options.galleryImageDefinitions,
        'galleryImageDefinitionName',
        resolvedConfig.galleryImageDefinitionName,
        'avd-gold-base'
      );

      if (imageDefSelection.needsSelection) {
        missingSelections.push(imageDefSelection.missingField);
      } else {
        resolvedConfig.galleryImageDefinitionName = imageDefSelection.value;
      }
    } else {
      options.galleryImageDefinitions = [];
    }
  } else {
    options.galleries = [];
    options.galleryImageDefinitions = [];
  }

  if (!isEmptyValue(resolvedConfig.hostPoolResourceGroup)) {
    let hostPools = [];
    let workspaces = [];
    let appGroups = [];

    try {
      hostPools = await listAvdResources('hostPools', resolvedConfig.subscriptionId, resolvedConfig.hostPoolResourceGroup, accessToken, managementEndpoint);
    } catch (error) {
      warnings.push(`Failed to enumerate host pools for resource group ${resolvedConfig.hostPoolResourceGroup}: ${error.response?.data?.error?.message || error.message}`);
    }

    try {
      workspaces = await listAvdResources('workspaces', resolvedConfig.subscriptionId, resolvedConfig.hostPoolResourceGroup, accessToken, managementEndpoint);
    } catch (error) {
      warnings.push(`Failed to enumerate workspaces for resource group ${resolvedConfig.hostPoolResourceGroup}: ${error.response?.data?.error?.message || error.message}`);
    }

    try {
      appGroups = await listAvdResources('applicationGroups', resolvedConfig.subscriptionId, resolvedConfig.hostPoolResourceGroup, accessToken, managementEndpoint);
    } catch (error) {
      warnings.push(`Failed to enumerate application groups for resource group ${resolvedConfig.hostPoolResourceGroup}: ${error.response?.data?.error?.message || error.message}`);
    }

    options.hostPools = hostPools.map((pool) => toSelectionOption(
      pool.name,
      `${pool.name} (${pool.properties?.friendlyName || pool.name})`
    ));
    options.workspaces = workspaces.map((workspace) => toSelectionOption(
      workspace.name,
      `${workspace.name} (${workspace.properties?.friendlyName || workspace.name})`
    ));
    options.applicationGroups = appGroups.map((appGroup) => toSelectionOption(
      appGroup.name,
      `${appGroup.name} (${appGroup.properties?.applicationGroupType || 'Unknown'})`
    ));

    const hostPoolSelection = buildWorkflowFieldSelection(options.hostPools, 'hostPoolName', resolvedConfig.hostPoolName, 'avd-cui-hp');
    if (hostPoolSelection.needsSelection) {
      missingSelections.push(hostPoolSelection.missingField);
    } else {
      resolvedConfig.hostPoolName = hostPoolSelection.value;
    }

    const workspaceSelection = buildWorkflowFieldSelection(options.workspaces, 'workspaceName', resolvedConfig.workspaceName, 'avd-cui-ws');
    if (workspaceSelection.needsSelection) {
      missingSelections.push(workspaceSelection.missingField);
    } else {
      resolvedConfig.workspaceName = workspaceSelection.value;
    }

    const desktopAgSelection = buildWorkflowFieldSelection(options.applicationGroups, 'desktopAppGroupName', resolvedConfig.desktopAppGroupName, 'avd-cui-dag');
    if (desktopAgSelection.needsSelection) {
      missingSelections.push(desktopAgSelection.missingField);
    } else {
      resolvedConfig.desktopAppGroupName = desktopAgSelection.value;
    }
  } else {
    options.hostPools = [];
    options.workspaces = [];
    options.applicationGroups = [];
  }

  return {
    resolvedConfig,
    options,
    missingSelections: [...new Set(missingSelections)],
    warnings,
    effectiveStages
  };
}

function validateWorkflowRequirements(config, effectiveStages) {
  const requiredFields = new Set(ALWAYS_REQUIRED_WORKFLOW_FIELDS);

  for (const stage of effectiveStages) {
    const stageRequirements = WORKFLOW_STAGE_REQUIREMENTS[stage] || [];
    for (const field of stageRequirements) {
      requiredFields.add(field);
    }
  }

  const missingRequired = [];
  for (const field of requiredFields) {
    if (isEmptyValue(config[field])) {
      missingRequired.push(field);
    }
  }

  if (!Number.isFinite(config.maxSessionLimit) || config.maxSessionLimit < 1) {
    missingRequired.push('maxSessionLimit');
  }
  if (!Number.isFinite(config.sessionHostCount) || config.sessionHostCount < 1) {
    missingRequired.push('sessionHostCount');
  }

  return [...new Set(missingRequired)];
}

async function ensureProviderRegistered(subscriptionId, providerNamespace, accessToken, managementEndpoint) {
  const providerUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/${providerNamespace}?api-version=${PROVIDER_API_VERSION}`;
  const provider = await armGet(providerUrl, accessToken);
  const currentState = provider.data?.registrationState;

  if (currentState === 'Registered') {
    return { providerNamespace, registrationState: currentState, action: 'none' };
  }

  const registerUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/${providerNamespace}/register?api-version=${PROVIDER_API_VERSION}`;
  await armPost(registerUrl, {}, accessToken);
  return { providerNamespace, registrationState: 'Registering', action: 'register' };
}

async function ensureResourceGroup(subscriptionId, resourceGroupName, location, accessToken, managementEndpoint) {
  const rgUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourcegroups/${resourceGroupName}?api-version=${RESOURCE_API_VERSION}`;
  const existing = await armGetIfExists(rgUrl, accessToken);
  if (existing) {
    return { id: existing.id, name: existing.name, location: existing.location, action: 'existing' };
  }

  const payload = { location };
  const created = await armPut(rgUrl, payload, accessToken);
  return { id: created.data?.id, name: created.data?.name, location: created.data?.location || location, action: 'created' };
}

async function getSubnetId(config, accessToken, managementEndpoint) {
  const vnetUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.vnetResourceGroup}/providers/Microsoft.Network/virtualNetworks/${config.vnetName}?api-version=${NETWORK_API_VERSION}`;
  const vnet = await armGet(vnetUrl, accessToken);
  const subnet = (vnet.data?.properties?.subnets || []).find((entry) => entry.name.toLowerCase() === config.sessionHostSubnetName.toLowerCase());
  if (!subnet) {
    const error = new Error(`Subnet '${config.sessionHostSubnetName}' was not found in VNet '${config.vnetName}'.`);
    error.code = 'SubnetNotFound';
    throw error;
  }
  return subnet.id;
}

async function ensureNetworkInterface({
  subscriptionId,
  resourceGroup,
  nicName,
  location,
  subnetId,
  accessToken,
  managementEndpoint
}) {
  const nicUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}?api-version=${NETWORK_API_VERSION}`;
  const existing = await armGetIfExists(nicUrl, accessToken);
  if (existing) {
    return { nic: existing, action: 'existing' };
  }

  const payload = {
    location,
    properties: {
      ipConfigurations: [
        {
          name: 'ipconfig1',
          properties: {
            subnet: { id: subnetId },
            privateIPAllocationMethod: 'Dynamic'
          }
        }
      ]
    }
  };

  const created = await armPut(nicUrl, payload, accessToken);
  return { nic: created.data, action: 'created' };
}

async function ensureBaseImageVm(config, accessToken, managementEndpoint) {
  const vmUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/virtualMachines/${config.baseVmName}?api-version=${COMPUTE_API_VERSION}`;
  const existingVm = await armGetIfExists(vmUrl, accessToken);
  if (existingVm) {
    return { vm: existingVm, action: 'existing' };
  }

  const subnetId = await getSubnetId(config, accessToken, managementEndpoint);
  const { nic } = await ensureNetworkInterface({
    subscriptionId: config.subscriptionId,
    resourceGroup: config.imageResourceGroup,
    nicName: `${config.baseVmName}-nic`,
    location: config.location,
    subnetId,
    accessToken,
    managementEndpoint
  });

  const vmPayload = {
    location: config.location,
    identity: { type: 'SystemAssigned' },
    properties: {
      hardwareProfile: { vmSize: config.baseVmSize },
      storageProfile: {
        imageReference: getBaseVmImageReference(config),
        osDisk: {
          createOption: 'FromImage',
          managedDisk: { storageAccountType: 'Premium_LRS' }
        }
      },
      osProfile: {
        computerName: config.baseVmName.substring(0, 15),
        adminUsername: config.localAdminUsername,
        adminPassword: config.localAdminPassword,
        windowsConfiguration: {
          provisionVMAgent: true,
          enableAutomaticUpdates: true,
          patchSettings: { patchMode: 'AutomaticByOS' }
        }
      },
      networkProfile: {
        networkInterfaces: [{ id: nic.id, properties: { primary: true } }]
      },
      diagnosticsProfile: { bootDiagnostics: { enabled: true } },
      securityProfile: {
        securityType: 'TrustedLaunch',
        uefiSettings: {
          secureBootEnabled: true,
          vTpmEnabled: true
        }
      }
    }
  };

  const createdVm = await armPut(vmUrl, vmPayload, accessToken);
  return { vm: createdVm.data, action: 'created' };
}

async function invokeVmRunCommand({
  vmId,
  scriptLines,
  accessToken,
  managementEndpoint
}) {
  const runUrl = `${managementEndpoint}${vmId}/runCommand?api-version=${COMPUTE_API_VERSION}`;
  const payload = {
    commandId: 'RunPowerShellScript',
    script: scriptLines
  };
  const response = await armPost(runUrl, payload, accessToken);
  return response.data;
}

async function applyBaseVmHardening(config, accessToken, managementEndpoint) {
  const vmId = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/virtualMachines/${config.baseVmName}`;
  const output = await invokeVmRunCommand({
    vmId,
    scriptLines: buildHardeningScript(config),
    accessToken,
    managementEndpoint
  });

  return {
    vmId,
    operation: output?.name || output?.id || 'RunCommand',
    status: output?.properties?.provisioningState || 'InProgress'
  };
}

async function waitForVmDeallocated(vmId, accessToken, managementEndpoint, timeoutMs = 30 * 60 * 1000) {
  const started = Date.now();
  const statusUrl = `${managementEndpoint}${vmId}/instanceView?api-version=${COMPUTE_API_VERSION}`;

  while (Date.now() - started < timeoutMs) {
    const response = await armGet(statusUrl, accessToken);
    const powerState = getVmPowerState(response.data);
    if (powerState && powerState.toLowerCase() === 'powerstate/deallocated') {
      return powerState;
    }
    await delay(20000);
  }

  const error = new Error(`Timed out waiting for VM ${vmId} to deallocate.`);
  error.code = 'VmDeallocateTimeout';
  throw error;
}

async function runSysprepAndCapture(config, accessToken, managementEndpoint) {
  const vmId = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/virtualMachines/${config.baseVmName}`;
  await invokeVmRunCommand({
    vmId,
    scriptLines: [
      '$ErrorActionPreference = "Stop"',
      'Start-Process -FilePath "C:\\Windows\\System32\\Sysprep\\Sysprep.exe" -ArgumentList "/generalize /oobe /shutdown /mode:vm" -Wait'
    ],
    accessToken,
    managementEndpoint
  });

  await waitForVmDeallocated(vmId, accessToken, managementEndpoint);

  const generalizeUrl = `${managementEndpoint}${vmId}/generalize?api-version=${COMPUTE_API_VERSION}`;
  await armPost(generalizeUrl, {}, accessToken);

  const galleryUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/galleries/${config.galleryName}?api-version=${GALLERY_API_VERSION}`;
  const existingGallery = await armGetIfExists(galleryUrl, accessToken);
  if (!existingGallery) {
    await armPut(galleryUrl, { location: config.location }, accessToken);
  }

  const imageDefinitionUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/galleries/${config.galleryName}/images/${config.galleryImageDefinitionName}?api-version=${GALLERY_API_VERSION}`;
  const existingImageDefinition = await armGetIfExists(imageDefinitionUrl, accessToken);
  if (!existingImageDefinition) {
    const imageDefPayload = {
      location: config.location,
      properties: {
        osType: 'Windows',
        osState: 'Generalized',
        hyperVGeneration: 'V2',
        identifier: {
          publisher: 'Clearwater',
          offer: 'AVD-CUI',
          sku: 'Gold'
        },
        features: [
          {
            name: 'SecurityType',
            value: ['TrustedLaunchSupported']
          }
        ]
      }
    };
    await armPut(imageDefinitionUrl, imageDefPayload, accessToken);
  }

  const imageVersionUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/galleries/${config.galleryName}/images/${config.galleryImageDefinitionName}/versions/${config.galleryImageVersion}?api-version=${GALLERY_API_VERSION}`;
  const existingImageVersion = await armGetIfExists(imageVersionUrl, accessToken);
  if (!existingImageVersion) {
    const imageVersionPayload = {
      location: config.location,
      properties: {
        publishingProfile: {
          targetRegions: [
            {
              name: config.location,
              regionalReplicaCount: 1
            }
          ]
        },
        storageProfile: {
          source: {
            id: vmId
          }
        }
      }
    };
    await armPut(imageVersionUrl, imageVersionPayload, accessToken);
  }

  return {
    galleryName: config.galleryName,
    imageDefinition: config.galleryImageDefinitionName,
    imageVersion: config.galleryImageVersion
  };
}

async function ensureHostPoolStack(config, accessToken, managementEndpoint) {
  const hostPoolUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${config.hostPoolName}?api-version=${AVD_API_VERSION}`;
  const hostPoolPayload = {
    location: config.location,
    properties: {
      hostPoolType: 'Pooled',
      loadBalancerType: 'BreadthFirst',
      maxSessionLimit: config.maxSessionLimit,
      preferredAppGroupType: 'Desktop',
      startVMOnConnect: true,
      friendlyName: config.hostPoolName,
      description: 'CUI host pool created by native AVD workflow',
      validationEnvironment: false
    }
  };
  const hostPool = await armPut(hostPoolUrl, hostPoolPayload, accessToken);

  const appGroupUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${config.desktopAppGroupName}?api-version=${AVD_API_VERSION}`;
  const appGroupPayload = {
    location: config.location,
    properties: {
      hostPoolArmPath: hostPool.data.id,
      applicationGroupType: 'Desktop',
      friendlyName: config.desktopAppGroupName,
      description: `Desktop application group for ${config.hostPoolName}`
    }
  };
  const desktopAppGroup = await armPut(appGroupUrl, appGroupPayload, accessToken);

  if (!isEmptyValue(config.remoteAppGroupName)) {
    const remoteAppGroupUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${config.remoteAppGroupName}?api-version=${AVD_API_VERSION}`;
    const remoteAppPayload = {
      location: config.location,
      properties: {
        hostPoolArmPath: hostPool.data.id,
        applicationGroupType: 'RemoteApp',
        friendlyName: config.remoteAppGroupName,
        description: `RemoteApp group for ${config.hostPoolName}`
      }
    };
    await armPut(remoteAppGroupUrl, remoteAppPayload, accessToken);
  }

  const appGroupReferences = [desktopAppGroup.data.id];
  if (!isEmptyValue(config.remoteAppGroupName)) {
    appGroupReferences.push(
      `/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${config.remoteAppGroupName}`
    );
  }

  const workspaceUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/workspaces/${config.workspaceName}?api-version=${AVD_API_VERSION}`;
  const workspacePayload = {
    location: config.location,
    properties: {
      friendlyName: config.workspaceName,
      description: `Workspace for ${config.hostPoolName}`,
      applicationGroupReferences: appGroupReferences
    }
  };
  const workspace = await armPut(workspaceUrl, workspacePayload, accessToken);

  return {
    hostPoolId: hostPool.data.id,
    desktopAppGroupId: desktopAppGroup.data.id,
    workspaceId: workspace.data.id
  };
}

async function generateHostPoolRegistrationToken(config, accessToken, managementEndpoint) {
  const hostPoolUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${config.hostPoolName}?api-version=${AVD_API_VERSION}`;
  const expirationTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    properties: {
      registrationInfo: {
        expirationTime,
        registrationTokenOperation: 'Update'
      }
    }
  };
  const response = await armPatch(hostPoolUrl, payload, accessToken);
  const token = response.data?.properties?.registrationInfo?.token;
  if (!token) {
    const error = new Error(`Failed to generate host pool registration token for ${config.hostPoolName}.`);
    error.code = 'RegistrationTokenFailed';
    throw error;
  }

  return { token, expirationTime };
}

function getSessionHostVmName(prefix, index) {
  return `${prefix}${String(index).padStart(2, '0')}`;
}

function getImageVersionResourceId(config) {
  return `/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/galleries/${config.galleryName}/images/${config.galleryImageDefinitionName}/versions/${config.galleryImageVersion}`;
}

async function ensureSessionHostVm(config, vmName, subnetId, accessToken, managementEndpoint) {
  const vmUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=${COMPUTE_API_VERSION}`;
  const existingVm = await armGetIfExists(vmUrl, accessToken);
  if (existingVm) {
    return { vm: existingVm, action: 'existing' };
  }

  const { nic } = await ensureNetworkInterface({
    subscriptionId: config.subscriptionId,
    resourceGroup: config.hostPoolResourceGroup,
    nicName: `${vmName}-nic`,
    location: config.location,
    subnetId,
    accessToken,
    managementEndpoint
  });

  const vmPayload = {
    location: config.location,
    identity: { type: 'SystemAssigned' },
    properties: {
      hardwareProfile: { vmSize: config.sessionHostVmSize },
      storageProfile: {
        imageReference: {
          id: getImageVersionResourceId(config)
        },
        osDisk: {
          createOption: 'FromImage',
          managedDisk: { storageAccountType: 'Premium_LRS' }
        }
      },
      osProfile: {
        computerName: vmName.substring(0, 15),
        adminUsername: config.localAdminUsername,
        adminPassword: config.localAdminPassword,
        windowsConfiguration: {
          provisionVMAgent: true,
          enableAutomaticUpdates: true,
          patchSettings: { patchMode: 'AutomaticByOS' }
        }
      },
      networkProfile: {
        networkInterfaces: [{ id: nic.id, properties: { primary: true } }]
      },
      diagnosticsProfile: { bootDiagnostics: { enabled: true } },
      securityProfile: {
        securityType: 'TrustedLaunch',
        uefiSettings: {
          secureBootEnabled: true,
          vTpmEnabled: true
        }
      },
      licenseType: 'Windows_Client'
    }
  };

  const vm = await armPut(vmUrl, vmPayload, accessToken);
  return { vm: vm.data, action: 'created' };
}

async function installSessionHostDscExtension(config, vmName, registrationToken, accessToken, managementEndpoint) {
  const extUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/extensions/Microsoft.PowerShell.DSC?api-version=${COMPUTE_API_VERSION}`;
  const extPayload = {
    location: config.location,
    properties: {
      publisher: 'Microsoft.Powershell',
      type: 'DSC',
      typeHandlerVersion: '2.73',
      autoUpgradeMinorVersion: true,
      settings: {
        modulesUrl: AVD_DSC_MODULES_ZIP,
        configurationFunction: 'Configuration.ps1\\AddSessionHost',
        properties: {
          hostPoolName: config.hostPoolName,
          registrationInfoTokenCredential: {
            UserName: 'PLACEHOLDER_DO_NOT_USE',
            Password: 'PrivateSettingsRef:RegistrationInfoToken'
          },
          aadJoin: true
        }
      },
      protectedSettings: {
        Items: {
          RegistrationInfoToken: registrationToken
        }
      }
    }
  };

  const response = await armPut(extUrl, extPayload, accessToken);
  return {
    extensionName: 'Microsoft.PowerShell.DSC',
    provisioningState: response.data?.properties?.provisioningState || 'InProgress'
  };
}

async function validateAvdWorkflow(config, accessToken, managementEndpoint) {
  const hostPoolUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${config.hostPoolName}?api-version=${AVD_API_VERSION}`;
  const sessionHostsUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.hostPoolResourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${config.hostPoolName}/sessionHosts?api-version=${AVD_API_VERSION}`;
  const imageVersionUrl = `${managementEndpoint}/subscriptions/${config.subscriptionId}/resourceGroups/${config.imageResourceGroup}/providers/Microsoft.Compute/galleries/${config.galleryName}/images/${config.galleryImageDefinitionName}/versions/${config.galleryImageVersion}?api-version=${GALLERY_API_VERSION}`;

  const [hostPool, sessionHosts, imageVersion] = await Promise.all([
    armGetIfExists(hostPoolUrl, accessToken),
    armGetIfExists(sessionHostsUrl, accessToken),
    armGetIfExists(imageVersionUrl, accessToken)
  ]);

  return {
    hostPoolName: config.hostPoolName,
    hostPoolProvisioningState: hostPool?.properties?.provisioningState || 'NotFound',
    sessionHostCount: Array.isArray(sessionHosts?.value) ? sessionHosts.value.length : 0,
    galleryImageVersion: config.galleryImageVersion,
    galleryVersionState: imageVersion?.properties?.provisioningState || 'NotFound'
  };
}

async function executeAvdNativeWorkflow({
  config,
  effectiveStages,
  accessToken,
  managementEndpoint
}) {
  const details = [];

  if (effectiveStages.includes('PrepareEnvironment')) {
    const providers = ['Microsoft.DesktopVirtualization', 'Microsoft.Compute', 'Microsoft.Network'];
    const providerResults = [];
    for (const providerNamespace of providers) {
      const providerResult = await ensureProviderRegistered(config.subscriptionId, providerNamespace, accessToken, managementEndpoint);
      providerResults.push(providerResult);
    }

    const imageRg = await ensureResourceGroup(config.subscriptionId, config.imageResourceGroup, config.location, accessToken, managementEndpoint);
    const hostPoolRg = await ensureResourceGroup(config.subscriptionId, config.hostPoolResourceGroup, config.location, accessToken, managementEndpoint);

    details.push({
      stage: 'PrepareEnvironment',
      status: 'Completed',
      providers: providerResults,
      resourceGroups: [imageRg, hostPoolRg]
    });
  }

  if (effectiveStages.includes('CreateBaseVm')) {
    const result = await ensureBaseImageVm(config, accessToken, managementEndpoint);
    details.push({
      stage: 'CreateBaseVm',
      status: 'Completed',
      action: result.action,
      vmId: result.vm?.id || null,
      vmName: config.baseVmName
    });
  }

  if (effectiveStages.includes('HardenBaseVm')) {
    const result = await applyBaseVmHardening(config, accessToken, managementEndpoint);
    details.push({
      stage: 'HardenBaseVm',
      status: 'Completed',
      ...result
    });
  }

  if (effectiveStages.includes('SysprepAndCapture')) {
    const captureResult = await runSysprepAndCapture(config, accessToken, managementEndpoint);
    details.push({
      stage: 'SysprepAndCapture',
      status: 'Completed',
      ...captureResult
    });
  }

  if (effectiveStages.includes('CreateHostPool')) {
    const stack = await ensureHostPoolStack(config, accessToken, managementEndpoint);
    details.push({
      stage: 'CreateHostPool',
      status: 'Completed',
      ...stack
    });
  }

  if (effectiveStages.includes('DeploySessionHosts')) {
    const subnetId = await getSubnetId(config, accessToken, managementEndpoint);
    const { token, expirationTime } = await generateHostPoolRegistrationToken(config, accessToken, managementEndpoint);
    const hosts = [];

    for (let idx = 1; idx <= config.sessionHostCount; idx += 1) {
      const vmName = getSessionHostVmName(config.sessionHostNamePrefix, idx);
      const vmResult = await ensureSessionHostVm(config, vmName, subnetId, accessToken, managementEndpoint);
      const extResult = await installSessionHostDscExtension(config, vmName, token, accessToken, managementEndpoint);
      hosts.push({
        vmName,
        vmAction: vmResult.action,
        vmId: vmResult.vm?.id || null,
        extensionState: extResult.provisioningState
      });
    }

    details.push({
      stage: 'DeploySessionHosts',
      status: 'Completed',
      registrationTokenExpires: expirationTime,
      hosts
    });
  }

  let validation = null;
  if (effectiveStages.includes('Validate')) {
    validation = await validateAvdWorkflow(config, accessToken, managementEndpoint);
    details.push({
      stage: 'Validate',
      status: 'Completed',
      validation
    });
  }

  return { details, validation };
}

/**
 * GET /api/ListAzureSubscriptions
 * List all Azure subscriptions the SAM app has access to
 */
router.get('/ListAzureSubscriptions', async (req, res) => {
  console.log(`[/api/ListAzureSubscriptions] Fetching subscriptions...`);

  try {
    const requestedTenant = resolveTenantFilterFromReq(req);
    const expectedTenantId = requestedTenant ? await normalizeTenantId(requestedTenant) : null;
    const accessToken = await getArmAccessToken(requestedTenant);
    const managementEndpoint = getAzureManagementEndpoint();
    const tokenTenantId = getTokenTenantId(accessToken);

    const url = `${managementEndpoint}/subscriptions?api-version=2022-12-01`;

    console.log(`[/api/ListAzureSubscriptions] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    let subscriptions = (response.data.value || []).map(sub => ({
      id: sub.subscriptionId,
      subscriptionId: sub.subscriptionId,
      displayName: sub.displayName,
      state: sub.state,
      tenantId: sub.tenantId,
      // For dropdown display
      label: `${sub.displayName} (${sub.subscriptionId.substring(0, 8)}...)`,
      value: sub.subscriptionId
    }));

    const tenantFilterId =
      expectedTenantId && /^[0-9a-f-]{36}$/i.test(expectedTenantId)
        ? expectedTenantId
        : tokenTenantId;
    if (tenantFilterId) {
      subscriptions = subscriptions.filter((sub) => sub.tenantId === tenantFilterId);
    }

    console.log(`[/api/ListAzureSubscriptions] Found ${subscriptions.length} subscriptions`);

    return res.json({
      Results: subscriptions,
      Metadata: {
        count: subscriptions.length,
        tokenTenantId,
        expectedTenantId: expectedTenantId || null,
        requestedTenant: requestedTenant || null
      }
    });
  } catch (error) {
    console.error(`[/api/ListAzureSubscriptions] Error:`, error.response?.data || error.message);

    const errorMessage = error.response?.data?.error?.message || error.message;

    if (error.response?.status === 403 || error.response?.status === 401) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'The SAM application does not have permission to list Azure subscriptions. Ensure the app has Reader role on the subscriptions.',
        Results: []
      });
    }

    return res.status(500).json({
      error: 'Failed to list subscriptions',
      message: errorMessage,
      Results: []
    });
  }
});

/**
 * GET /api/ListAzureResourceGroups
 * List resource groups in a subscription
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 */
router.get('/ListAzureResourceGroups', async (req, res) => {
  const { subscriptionId } = req.query;

  console.log(`[/api/ListAzureResourceGroups] Fetching resource groups for: ${subscriptionId}`);

  if (!subscriptionId) {
    return res.status(400).json({
      error: 'subscriptionId is required',
      Results: []
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourcegroups?api-version=2022-12-01`;

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const resourceGroups = (response.data.value || []).map(rg => ({
      id: rg.id,
      name: rg.name,
      location: rg.location,
      // For dropdown display
      label: rg.name,
      value: rg.name
    }));

    console.log(`[/api/ListAzureResourceGroups] Found ${resourceGroups.length} resource groups`);

    return res.json({
      Results: resourceGroups,
      Metadata: {
        subscriptionId,
        count: resourceGroups.length
      }
    });
  } catch (error) {
    console.error(`[/api/ListAzureResourceGroups] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list resource groups',
      message: error.response?.data?.error?.message || error.message,
      Results: []
    });
  }
});

/**
 * GET /api/ListAVDHostPools
 * List all host pools across subscriptions
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Optional resource group filter
 */
router.get('/ListAVDHostPools', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query;
  const requestedTenant = resolveTenantFilterFromReq(req);

  console.log(`[/api/ListAVDHostPools] Getting host pools for subscription: ${subscriptionId}`);

  if (!subscriptionId) {
    return res.status(400).json({
      error: 'subscriptionId is required',
      message: 'Please provide an Azure subscription ID'
    });
  }

  try {
    const expectedTenantId = requestedTenant ? await normalizeTenantId(requestedTenant) : null;
    const accessToken = await getArmAccessToken(requestedTenant);
    const managementEndpoint = getAzureManagementEndpoint();
    const tokenTenantId = getTokenTenantId(accessToken);
    const tenantFilterId =
      expectedTenantId && /^[0-9a-f-]{36}$/i.test(expectedTenantId)
        ? expectedTenantId
        : tokenTenantId;

    if (tenantFilterId) {
      const subscriptionTenantId = await getSubscriptionTenantId(subscriptionId, accessToken, managementEndpoint);
      if (subscriptionTenantId && subscriptionTenantId !== tenantFilterId) {
        return res.status(403).json({
          error: 'Subscription tenant mismatch',
          message: `Selected subscription belongs to tenant ${subscriptionTenantId}, but requested tenant is ${tenantFilterId}.`,
          code: 'SubscriptionTenantMismatch'
        });
      }
    }

    let url;
    if (resourceGroup) {
      // List host pools in specific resource group
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools?api-version=${AVD_API_VERSION}`;
    } else {
      // List all host pools in subscription
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.DesktopVirtualization/hostPools?api-version=${AVD_API_VERSION}`;
    }

    console.log(`[/api/ListAVDHostPools] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const hostPools = (response.data.value || []).map(pool => ({
      id: pool.id,
      name: pool.name,
      type: pool.type,
      location: pool.location,
      resourceGroup: pool.id.split('/')[4],
      hostPoolType: pool.properties?.hostPoolType,
      loadBalancerType: pool.properties?.loadBalancerType,
      maxSessionLimit: pool.properties?.maxSessionLimit,
      description: pool.properties?.description,
      friendlyName: pool.properties?.friendlyName || pool.name,
      startVMOnConnect: pool.properties?.startVMOnConnect,
      validationEnvironment: pool.properties?.validationEnvironment,
      personalDesktopAssignmentType: pool.properties?.personalDesktopAssignmentType,
      preferredAppGroupType: pool.properties?.preferredAppGroupType,
      publicNetworkAccess: pool.properties?.publicNetworkAccess,
      // Registration info
      registrationTokenExpiry: pool.properties?.registrationInfo?.expirationTime,
      // Agent update settings
      agentUpdateType: pool.properties?.agentUpdate?.type,
      agentUpdateMaintenanceWindow: pool.properties?.agentUpdate?.maintenanceWindows,
      // Metadata
      tags: pool.tags,
      createdAt: pool.systemData?.createdAt,
      lastModifiedAt: pool.systemData?.lastModifiedAt
    }));

    console.log(`[/api/ListAVDHostPools] Found ${hostPools.length} host pools`);

    return res.json({
      Results: hostPools,
      Metadata: {
        subscriptionId,
        resourceGroup: resourceGroup || 'All',
        count: hostPools.length,
        requestedTenant: requestedTenant || null,
        tenantFilterId: tenantFilterId || null
      }
    });
  } catch (error) {
    console.error(`[/api/ListAVDHostPools] Error:`, error.response?.data || error.message);

    const errorMessage = error.response?.data?.error?.message || error.message;
    const errorCode = error.response?.data?.error?.code || 'UnknownError';

    // Handle common errors
    if (error.response?.status === 403) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'The application does not have permission to access AVD resources. Ensure the SAM app has the Desktop Virtualization Reader or Contributor role on the subscription.',
        code: errorCode,
        permissionError: {
          requiredPermissions: ['Desktop Virtualization Reader', 'Desktop Virtualization Contributor'],
          howToFix: 'Grant the SAM application role assignment on the Azure subscription for AVD resources.'
        }
      });
    }

    if (error.response?.status === 404) {
      return res.status(404).json({
        error: 'Resource not found',
        message: 'The subscription or resource group was not found, or AVD is not enabled.',
        code: errorCode
      });
    }

    return res.status(500).json({
      error: 'Failed to list host pools',
      message: errorMessage,
      code: errorCode
    });
  }
});

/**
 * GET /api/ListAVDSessionHosts
 * List session hosts in a host pool
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 */
router.get('/ListAVDSessionHosts', async (req, res) => {
  const { subscriptionId, resourceGroup, hostPoolName } = req.query;

  console.log(`[/api/ListAVDSessionHosts] Getting session hosts for pool: ${hostPoolName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and hostPoolName are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/sessionHosts?api-version=${AVD_API_VERSION}`;

    console.log(`[/api/ListAVDSessionHosts] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const sessionHosts = (response.data.value || []).map(host => ({
      id: host.id,
      name: host.name,
      type: host.type,
      hostPoolName: hostPoolName,
      resourceGroup: resourceGroup,
      // Core properties
      status: host.properties?.status,
      statusTimestamp: host.properties?.statusTimestamp,
      allowNewSession: host.properties?.allowNewSession,
      sessions: host.properties?.sessions || 0,
      assignedUser: host.properties?.assignedUser,
      friendlyName: host.properties?.friendlyName || host.name,
      // Agent info
      agentVersion: host.properties?.agentVersion,
      lastHeartBeat: host.properties?.lastHeartBeat,
      // OS info
      osVersion: host.properties?.osVersion,
      sxSStackVersion: host.properties?.sxSStackVersion,
      // Update info
      updateState: host.properties?.updateState,
      lastUpdateTime: host.properties?.lastUpdateTime,
      updateErrorMessage: host.properties?.updateErrorMessage,
      // VM reference
      virtualMachineId: host.properties?.virtualMachineId,
      resourceId: host.properties?.resourceId,
      // Health check results
      healthCheckResults: host.properties?.sessionHostHealthCheckResults || [],
      // Metadata
      createdAt: host.systemData?.createdAt,
      lastModifiedAt: host.systemData?.lastModifiedAt
    }));

    console.log(`[/api/ListAVDSessionHosts] Found ${sessionHosts.length} session hosts`);

    return res.json({
      Results: sessionHosts,
      Metadata: {
        subscriptionId,
        resourceGroup,
        hostPoolName,
        count: sessionHosts.length
      }
    });
  } catch (error) {
    console.error(`[/api/ListAVDSessionHosts] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list session hosts',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAVDUserSessions
 * List user sessions on a session host or across a host pool
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 * - sessionHostName: Optional session host name (if omitted, lists all sessions in pool)
 */
router.get('/ListAVDUserSessions', async (req, res) => {
  const { subscriptionId, resourceGroup, hostPoolName, sessionHostName } = req.query;

  console.log(`[/api/ListAVDUserSessions] Getting user sessions for pool: ${hostPoolName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and hostPoolName are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    let url;
    if (sessionHostName) {
      // List sessions on specific session host
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/sessionHosts/${sessionHostName}/userSessions?api-version=${AVD_API_VERSION}`;
    } else {
      // List all sessions in host pool
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/userSessions?api-version=${AVD_API_VERSION}`;
    }

    console.log(`[/api/ListAVDUserSessions] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const userSessions = (response.data.value || []).map(session => ({
      id: session.id,
      name: session.name,
      type: session.type,
      hostPoolName: hostPoolName,
      resourceGroup: resourceGroup,
      // Extract session host name from ID if not provided
      sessionHostName: sessionHostName || session.id.split('/sessionHosts/')[1]?.split('/')[0],
      sessionId: session.name,
      // Session properties
      userPrincipalName: session.properties?.userPrincipalName,
      activeDirectoryUserName: session.properties?.activeDirectoryUserName,
      applicationType: session.properties?.applicationType,
      sessionState: session.properties?.sessionState,
      createTime: session.properties?.createTime,
      // Metadata
      createdAt: session.systemData?.createdAt
    }));

    console.log(`[/api/ListAVDUserSessions] Found ${userSessions.length} user sessions`);

    return res.json({
      Results: userSessions,
      Metadata: {
        subscriptionId,
        resourceGroup,
        hostPoolName,
        sessionHostName: sessionHostName || 'All',
        count: userSessions.length
      }
    });
  } catch (error) {
    console.error(`[/api/ListAVDUserSessions] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list user sessions',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecAVDUserSessionAction
 * Execute an action on a user session (disconnect, logoff, send message)
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 * - sessionHostName: Session host name (required)
 * - sessionId: Session ID (required)
 * - action: Action to perform (disconnect, delete, sendMessage) (required)
 * - message: Message to send (required for sendMessage action)
 * - messageTitle: Message title (optional, for sendMessage)
 */
router.post('/ExecAVDUserSessionAction', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    sessionHostName,
    sessionId,
    action,
    message,
    messageTitle
  } = req.body;

  console.log(`[/api/ExecAVDUserSessionAction] Action: ${action} on session: ${sessionId}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName || !sessionHostName || !sessionId || !action) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, hostPoolName, sessionHostName, sessionId, and action are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const baseUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/sessionHosts/${sessionHostName}/userSessions/${sessionId}`;

    let url;
    let method = 'POST';
    let payload = null;

    switch (action.toLowerCase()) {
      case 'disconnect':
        url = `${baseUrl}/disconnect?api-version=${AVD_API_VERSION}`;
        break;

      case 'delete':
      case 'logoff':
        // Delete session = force logoff
        url = `${baseUrl}?api-version=${AVD_API_VERSION}&force=true`;
        method = 'DELETE';
        break;

      case 'sendmessage':
        if (!message) {
          return res.status(400).json({
            error: 'message is required for sendMessage action'
          });
        }
        url = `${baseUrl}/sendMessage?api-version=${AVD_API_VERSION}`;
        payload = {
          messageTitle: messageTitle || 'Message from Administrator',
          messageBody: message
        };
        break;

      default:
        return res.status(400).json({
          error: `Unknown action: ${action}`,
          supportedActions: ['disconnect', 'logoff', 'delete', 'sendMessage']
        });
    }

    console.log(`[/api/ExecAVDUserSessionAction] ${method} ${url}`);

    const requestConfig = {
      method,
      url,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    };

    if (payload) {
      requestConfig.data = payload;
    }

    await axios(requestConfig);

    console.log(`[/api/ExecAVDUserSessionAction] Successfully executed ${action} on session ${sessionId}`);

    return res.json({
      Results: `Successfully executed ${action} on session ${sessionId}`,
      severity: 'success'
    });
  } catch (error) {
    console.error(`[/api/ExecAVDUserSessionAction] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: `Failed to ${action} session`,
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecAVDSessionHostAction
 * Execute an action on a session host (update drain mode, delete)
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 * - sessionHostName: Session host name (required)
 * - action: Action to perform (setDrainMode, delete) (required)
 * - allowNewSession: Boolean (required for setDrainMode)
 */
router.post('/ExecAVDSessionHostAction', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    sessionHostName,
    action,
    allowNewSession
  } = req.body;

  console.log(`[/api/ExecAVDSessionHostAction] Action: ${action} on host: ${sessionHostName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName || !sessionHostName || !action) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, hostPoolName, sessionHostName, and action are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const baseUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/sessionHosts/${sessionHostName}`;

    let url;
    let method = 'PATCH';
    let payload = null;

    switch (action.toLowerCase()) {
      case 'setdrainmode':
      case 'enabledrainmode':
        url = `${baseUrl}?api-version=${AVD_API_VERSION}`;
        payload = {
          properties: {
            allowNewSession: allowNewSession === true || allowNewSession === 'true'
          }
        };
        break;

      case 'delete':
        url = `${baseUrl}?api-version=${AVD_API_VERSION}&force=true`;
        method = 'DELETE';
        break;

      default:
        return res.status(400).json({
          error: `Unknown action: ${action}`,
          supportedActions: ['setDrainMode', 'delete']
        });
    }

    console.log(`[/api/ExecAVDSessionHostAction] ${method} ${url}`);

    const requestConfig = {
      method,
      url,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    };

    if (payload) {
      requestConfig.data = payload;
    }

    await axios(requestConfig);

    const resultMessage = action.toLowerCase() === 'setdrainmode'
      ? `Session host ${sessionHostName} drain mode set to ${allowNewSession ? 'disabled (accepting sessions)' : 'enabled (not accepting sessions)'}`
      : `Successfully executed ${action} on session host ${sessionHostName}`;

    console.log(`[/api/ExecAVDSessionHostAction] ${resultMessage}`);

    return res.json({
      Results: resultMessage,
      severity: 'success'
    });
  } catch (error) {
    console.error(`[/api/ExecAVDSessionHostAction] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: `Failed to ${action} session host`,
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAVDApplicationGroups
 * List application groups in a host pool or subscription
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Optional resource group filter
 * - hostPoolName: Optional host pool filter
 */
router.get('/ListAVDApplicationGroups', async (req, res) => {
  const { subscriptionId, resourceGroup, hostPoolName } = req.query;

  console.log(`[/api/ListAVDApplicationGroups] Getting application groups for subscription: ${subscriptionId}`);

  if (!subscriptionId) {
    return res.status(400).json({
      error: 'subscriptionId is required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    let url;
    if (resourceGroup) {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups?api-version=${AVD_API_VERSION}`;
    } else {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.DesktopVirtualization/applicationGroups?api-version=${AVD_API_VERSION}`;
    }

    console.log(`[/api/ListAVDApplicationGroups] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    let appGroups = (response.data.value || []).map(group => ({
      id: group.id,
      name: group.name,
      type: group.type,
      location: group.location,
      resourceGroup: group.id.split('/')[4],
      hostPoolArmPath: group.properties?.hostPoolArmPath,
      hostPoolName: group.properties?.hostPoolArmPath?.split('/').pop(),
      applicationGroupType: group.properties?.applicationGroupType,
      description: group.properties?.description,
      friendlyName: group.properties?.friendlyName || group.name,
      workspaceArmPath: group.properties?.workspaceArmPath,
      tags: group.tags,
      createdAt: group.systemData?.createdAt,
      lastModifiedAt: group.systemData?.lastModifiedAt
    }));

    // Filter by host pool if specified
    if (hostPoolName) {
      appGroups = appGroups.filter(g => g.hostPoolName === hostPoolName);
    }

    console.log(`[/api/ListAVDApplicationGroups] Found ${appGroups.length} application groups`);

    return res.json({
      Results: appGroups,
      Metadata: {
        subscriptionId,
        resourceGroup: resourceGroup || 'All',
        hostPoolName: hostPoolName || 'All',
        count: appGroups.length
      }
    });
  } catch (error) {
    console.error(`[/api/ListAVDApplicationGroups] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list application groups',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAVDWorkspaces
 * List AVD workspaces
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Optional resource group filter
 */
router.get('/ListAVDWorkspaces', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query;

  console.log(`[/api/ListAVDWorkspaces] Getting workspaces for subscription: ${subscriptionId}`);

  if (!subscriptionId) {
    return res.status(400).json({
      error: 'subscriptionId is required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    let url;
    if (resourceGroup) {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/workspaces?api-version=${AVD_API_VERSION}`;
    } else {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.DesktopVirtualization/workspaces?api-version=${AVD_API_VERSION}`;
    }

    console.log(`[/api/ListAVDWorkspaces] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const workspaces = (response.data.value || []).map(workspace => ({
      id: workspace.id,
      name: workspace.name,
      type: workspace.type,
      location: workspace.location,
      resourceGroup: workspace.id.split('/')[4],
      description: workspace.properties?.description,
      friendlyName: workspace.properties?.friendlyName || workspace.name,
      applicationGroupReferences: workspace.properties?.applicationGroupReferences || [],
      publicNetworkAccess: workspace.properties?.publicNetworkAccess,
      tags: workspace.tags,
      createdAt: workspace.systemData?.createdAt,
      lastModifiedAt: workspace.systemData?.lastModifiedAt
    }));

    console.log(`[/api/ListAVDWorkspaces] Found ${workspaces.length} workspaces`);

    return res.json({
      Results: workspaces,
      Metadata: {
        subscriptionId,
        resourceGroup: resourceGroup || 'All',
        count: workspaces.length
      }
    });
  } catch (error) {
    console.error(`[/api/ListAVDWorkspaces] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list workspaces',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecCreateAVDHostPool
 * Create a new AVD host pool with workspace and application group
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 * - location: Azure region (required)
 * - friendlyName: Display name (optional)
 * - description: Description (optional)
 * - hostPoolType: 'Pooled' or 'Personal' (default: 'Pooled')
 * - loadBalancerType: 'BreadthFirst', 'DepthFirst', or 'Persistent' (default: 'BreadthFirst')
 * - maxSessionLimit: Max sessions per host (default: 10)
 * - preferredAppGroupType: 'Desktop' or 'RailApplications' (default: 'Desktop')
 * - startVMOnConnect: Boolean (default: false)
 * - createWorkspace: Boolean (default: true)
 * - workspaceName: Name for workspace (optional, defaults to hostPoolName-ws)
 */
router.post('/ExecCreateAVDHostPool', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    location,
    friendlyName,
    description,
    hostPoolType = 'Pooled',
    loadBalancerType = 'BreadthFirst',
    maxSessionLimit = 10,
    preferredAppGroupType = 'Desktop',
    startVMOnConnect = false,
    createWorkspace = true,
    workspaceName
  } = req.body;

  console.log(`[/api/ExecCreateAVDHostPool] Creating host pool: ${hostPoolName} in ${resourceGroup}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName || !location) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, hostPoolName, and location are required'
    });
  }

  // Validate hostPoolType
  if (!['Pooled', 'Personal'].includes(hostPoolType)) {
    return res.status(400).json({
      error: 'hostPoolType must be either "Pooled" or "Personal"'
    });
  }

  // Validate loadBalancerType based on hostPoolType
  const validLoadBalancerTypes = hostPoolType === 'Pooled'
    ? ['BreadthFirst', 'DepthFirst']
    : ['Persistent'];

  if (!validLoadBalancerTypes.includes(loadBalancerType)) {
    return res.status(400).json({
      error: `loadBalancerType must be one of: ${validLoadBalancerTypes.join(', ')}`
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const results = [];

    // Step 1: Create the host pool
    console.log(`[/api/ExecCreateAVDHostPool] Step 1: Creating host pool...`);
    const hostPoolUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}?api-version=${AVD_API_VERSION}`;

    const hostPoolPayload = {
      location,
      properties: {
        hostPoolType,
        loadBalancerType,
        maxSessionLimit: parseInt(maxSessionLimit, 10),
        preferredAppGroupType,
        startVMOnConnect,
        friendlyName: friendlyName || hostPoolName,
        description: description || `Host pool created via CIPP`,
        validationEnvironment: false,
        // Generate a registration token valid for 24 hours
        registrationInfo: {
          expirationTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          registrationTokenOperation: 'Update'
        }
      }
    };

    // Add personal desktop assignment type if Personal pool
    if (hostPoolType === 'Personal') {
      hostPoolPayload.properties.personalDesktopAssignmentType = 'Automatic';
    }

    const hostPoolResponse = await axios.put(hostPoolUrl, hostPoolPayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    results.push({
      resource: 'Host Pool',
      name: hostPoolName,
      status: 'Created',
      id: hostPoolResponse.data.id
    });

    const registrationToken = hostPoolResponse.data?.properties?.registrationInfo?.token;

    // Step 2: Create the Desktop Application Group
    console.log(`[/api/ExecCreateAVDHostPool] Step 2: Creating application group...`);
    const appGroupName = `${hostPoolName}-dag`;
    const appGroupUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${appGroupName}?api-version=${AVD_API_VERSION}`;

    const appGroupPayload = {
      location,
      properties: {
        hostPoolArmPath: hostPoolResponse.data.id,
        applicationGroupType: preferredAppGroupType === 'Desktop' ? 'Desktop' : 'RemoteApp',
        friendlyName: `${friendlyName || hostPoolName} Desktop`,
        description: `Desktop application group for ${hostPoolName}`
      }
    };

    const appGroupResponse = await axios.put(appGroupUrl, appGroupPayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    results.push({
      resource: 'Application Group',
      name: appGroupName,
      status: 'Created',
      id: appGroupResponse.data.id
    });

    // Step 3: Create the Workspace (if requested)
    let workspaceId = null;
    if (createWorkspace) {
      console.log(`[/api/ExecCreateAVDHostPool] Step 3: Creating workspace...`);
      const wsName = workspaceName || `${hostPoolName}-ws`;
      const workspaceUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/workspaces/${wsName}?api-version=${AVD_API_VERSION}`;

      const workspacePayload = {
        location,
        properties: {
          friendlyName: `${friendlyName || hostPoolName} Workspace`,
          description: `Workspace for ${hostPoolName}`,
          applicationGroupReferences: [appGroupResponse.data.id]
        }
      };

      const workspaceResponse = await axios.put(workspaceUrl, workspacePayload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      workspaceId = workspaceResponse.data.id;
      results.push({
        resource: 'Workspace',
        name: wsName,
        status: 'Created',
        id: workspaceId
      });
    }

    console.log(`[/api/ExecCreateAVDHostPool] Successfully created AVD resources`);

    return res.json({
      Results: `Successfully created AVD host pool "${hostPoolName}" with application group${createWorkspace ? ' and workspace' : ''}`,
      severity: 'success',
      details: results,
      registrationToken,
      registrationTokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
  } catch (error) {
    console.error(`[/api/ExecCreateAVDHostPool] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to create host pool',
      message: error.response?.data?.error?.message || error.message,
      code: error.response?.data?.error?.code
    });
  }
});

/**
 * POST /api/ExecAVDHostPoolAction
 * Execute an action on a host pool (generate registration token, update settings)
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 * - action: Action to perform (generateRegistrationToken, updateSettings) (required)
 * - expirationTime: Token expiration time (for generateRegistrationToken)
 * - settings: Object with settings to update (for updateSettings)
 */
router.post('/ExecAVDHostPoolAction', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    action,
    expirationTime,
    settings
  } = req.body;

  console.log(`[/api/ExecAVDHostPoolAction] Action: ${action} on pool: ${hostPoolName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName || !action) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, hostPoolName, and action are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const baseUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}`;

    switch (action.toLowerCase()) {
      case 'generateregistrationtoken': {
        // Generate a new registration token
        // Default expiration: 24 hours from now
        const expiry = expirationTime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        const url = `${baseUrl}?api-version=${AVD_API_VERSION}`;

        const response = await axios.patch(url, {
          properties: {
            registrationInfo: {
              expirationTime: expiry,
              registrationTokenOperation: 'Update'
            }
          }
        }, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        const token = response.data?.properties?.registrationInfo?.token;

        console.log(`[/api/ExecAVDHostPoolAction] Generated registration token for ${hostPoolName}`);

        return res.json({
          Results: `Registration token generated successfully`,
          severity: 'success',
          token: token,
          expirationTime: expiry
        });
      }

      case 'updatesettings': {
        if (!settings || typeof settings !== 'object') {
          return res.status(400).json({
            error: 'settings object is required for updateSettings action'
          });
        }

        const url = `${baseUrl}?api-version=${AVD_API_VERSION}`;

        await axios.patch(url, {
          properties: settings
        }, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        console.log(`[/api/ExecAVDHostPoolAction] Updated settings for ${hostPoolName}`);

        return res.json({
          Results: `Host pool settings updated successfully`,
          severity: 'success'
        });
      }

      default:
        return res.status(400).json({
          error: `Unknown action: ${action}`,
          supportedActions: ['generateRegistrationToken', 'updateSettings']
        });
    }
  } catch (error) {
    console.error(`[/api/ExecAVDHostPoolAction] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: `Failed to ${action} on host pool`,
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAzureVMs
 * List all VMs in a subscription or resource group that could be used as session hosts
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Optional resource group filter
 */
router.get('/ListAzureVMs', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query;

  console.log(`[/api/ListAzureVMs] Listing VMs for subscription: ${subscriptionId}, resourceGroup: ${resourceGroup || 'all'}`);

  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    // Build the URL based on whether resourceGroup is specified
    let url;
    if (resourceGroup) {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines?api-version=2024-03-01`;
    } else {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-03-01`;
    }

    console.log(`[/api/ListAzureVMs] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Transform the data for easier consumption
    // Filter to only Windows VMs since AVD session hosts must be Windows
    const vms = (response.data.value || [])
      .filter(vm => vm.properties?.storageProfile?.osDisk?.osType === 'Windows')
      .map(vm => {
        // Extract resource group from VM ID
        const idParts = vm.id.split('/');
        const rgIndex = idParts.indexOf('resourceGroups');
        const vmResourceGroup = rgIndex !== -1 ? idParts[rgIndex + 1] : '';

        return {
          id: vm.id,
          name: vm.name,
          location: vm.location,
          resourceGroup: vmResourceGroup,
          vmSize: vm.properties?.hardwareProfile?.vmSize,
          osType: vm.properties?.storageProfile?.osDisk?.osType,
          provisioningState: vm.properties?.provisioningState,
          powerState: vm.properties?.instanceView?.statuses?.find(s => s.code?.startsWith('PowerState/'))?.displayStatus || 'Unknown',
          computerName: vm.properties?.osProfile?.computerName,
          adminUsername: vm.properties?.osProfile?.adminUsername,
          privateIpAddress: vm.properties?.networkProfile?.networkInterfaces?.[0]?.properties?.ipConfigurations?.[0]?.properties?.privateIPAddress,
          imageReference: vm.properties?.storageProfile?.imageReference,
          tags: vm.tags
        };
      });

    console.log(`[/api/ListAzureVMs] Found ${vms.length} Windows VMs (filtered from total)`);

    return res.json({
      Results: vms,
      count: vms.length
    });
  } catch (error) {
    console.error(`[/api/ListAzureVMs] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list VMs',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAzureVMImages
 * List available VM images for creating session hosts
 *
 * Query params:
 * - location: Azure region (required)
 * - publisher: Image publisher filter (optional, default: MicrosoftWindowsDesktop)
 */
router.get('/ListAzureVMImages', async (req, res) => {
  const { location, publisher = 'MicrosoftWindowsDesktop' } = req.query;
  // Use a dummy subscriptionId since we need one for the API
  const subscriptionId = req.query.subscriptionId;

  console.log(`[/api/ListAzureVMImages] Listing images for location: ${location}, publisher: ${publisher}`);

  if (!location || !subscriptionId) {
    return res.status(400).json({ error: 'location and subscriptionId are required' });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    // Get offers from the publisher
    const offersUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/publishers/${publisher}/artifacttypes/vmimage/offers?api-version=2024-03-01`;

    const offersResponse = await axios.get(offersUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    // Filter to common AVD-related offers
    const avdOffers = (offersResponse.data || []).filter(offer =>
      offer.name.includes('Windows-10') ||
      offer.name.includes('Windows-11') ||
      offer.name.includes('office-365')
    );

    // Get SKUs for each offer
    const images = [];
    for (const offer of avdOffers.slice(0, 5)) { // Limit to avoid too many API calls
      try {
        const skusUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/publishers/${publisher}/artifacttypes/vmimage/offers/${offer.name}/skus?api-version=2024-03-01`;

        const skusResponse = await axios.get(skusUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        for (const sku of (skusResponse.data || []).slice(0, 5)) {
          images.push({
            publisher,
            offer: offer.name,
            sku: sku.name,
            displayName: `${offer.name} - ${sku.name}`
          });
        }
      } catch (err) {
        console.log(`[/api/ListAzureVMImages] Failed to get SKUs for offer ${offer.name}`);
      }
    }

    console.log(`[/api/ListAzureVMImages] Found ${images.length} images`);

    return res.json({
      Results: images,
      count: images.length
    });
  } catch (error) {
    console.error(`[/api/ListAzureVMImages] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list VM images',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAzureVMSizes
 * List available VM sizes for a location
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - location: Azure region (required)
 */
router.get('/ListAzureVMSizes', async (req, res) => {
  const { subscriptionId, location } = req.query;

  console.log(`[/api/ListAzureVMSizes] Listing VM sizes for location: ${location}`);

  if (!subscriptionId || !location) {
    return res.status(400).json({ error: 'subscriptionId and location are required' });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/vmSizes?api-version=2024-03-01`;

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    // Filter to common desktop sizes and sort by cores/memory
    const sizes = (response.data.value || [])
      .filter(size =>
        // Common AVD-suitable sizes
        size.name.startsWith('Standard_D') ||
        size.name.startsWith('Standard_E') ||
        size.name.startsWith('Standard_F') ||
        size.name.startsWith('Standard_B')
      )
      .map(size => ({
        name: size.name,
        cores: size.numberOfCores,
        memoryGB: Math.round(size.memoryInMB / 1024),
        maxDataDisks: size.maxDataDiskCount,
        displayName: `${size.name} (${size.numberOfCores} vCPUs, ${Math.round(size.memoryInMB / 1024)} GB RAM)`
      }))
      .sort((a, b) => a.cores - b.cores || a.memoryGB - b.memoryGB);

    console.log(`[/api/ListAzureVMSizes] Found ${sizes.length} VM sizes`);

    return res.json({
      Results: sizes,
      count: sizes.length
    });
  } catch (error) {
    console.error(`[/api/ListAzureVMSizes] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list VM sizes',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAzureVNets
 * List virtual networks in a subscription
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Optional resource group filter
 */
router.get('/ListAzureVNets', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query;

  console.log(`[/api/ListAzureVNets] Listing VNets for subscription: ${subscriptionId}`);

  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    let url;
    if (resourceGroup) {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`;
    } else {
      url = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`;
    }

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const vnets = (response.data.value || []).map(vnet => {
      // Extract resource group from vnet ID
      const idParts = vnet.id.split('/');
      const rgIndex = idParts.indexOf('resourceGroups');
      const vnetResourceGroup = rgIndex !== -1 ? idParts[rgIndex + 1] : '';

      return {
        id: vnet.id,
        name: vnet.name,
        location: vnet.location,
        resourceGroup: vnetResourceGroup,
        addressSpace: vnet.properties?.addressSpace?.addressPrefixes,
        subnets: (vnet.properties?.subnets || []).map(subnet => ({
          id: subnet.id,
          name: subnet.name,
          addressPrefix: subnet.properties?.addressPrefix
        }))
      };
    });

    console.log(`[/api/ListAzureVNets] Found ${vnets.length} VNets`);

    return res.json({
      Results: vnets,
      count: vnets.length
    });
  } catch (error) {
    console.error(`[/api/ListAzureVNets] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list VNets',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecDeployAVDSessionHost
 * Deploy a new VM as an AVD session host
 *
 * This creates a VM with the AVD agent and registers it with the host pool
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group for the VM (required)
 * - hostPoolName: Host pool to join (required)
 * - hostPoolResourceGroup: Resource group of the host pool (required)
 * - vmName: Name for the new VM (required)
 * - location: Azure region (required)
 * - vmSize: VM size (required)
 * - imageReference: VM image (required - object with publisher, offer, sku, version)
 * - subnetId: Subnet to connect the VM to (required)
 * - adminUsername: Admin username (required)
 * - adminPassword: Admin password (required)
 * - domainToJoin: AD domain to join (optional)
 * - domainUsername: Domain join username (optional)
 * - domainPassword: Domain join password (optional)
 * - registrationToken: AVD registration token (required)
 */
router.post('/ExecDeployAVDSessionHost', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    hostPoolResourceGroup,
    vmName,
    location,
    vmSize,
    imageReference,
    subnetId,
    adminUsername,
    adminPassword,
    domainToJoin,
    domainUsername,
    domainPassword,
    registrationToken
  } = req.body;

  console.log(`[/api/ExecDeployAVDSessionHost] Deploying session host: ${vmName} to pool: ${hostPoolName}`);

  // Validate required fields
  if (!subscriptionId || !resourceGroup || !vmName || !location || !vmSize || !subnetId || !adminUsername || !adminPassword || !registrationToken) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['subscriptionId', 'resourceGroup', 'vmName', 'location', 'vmSize', 'subnetId', 'adminUsername', 'adminPassword', 'registrationToken']
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const results = [];

    // Step 1: Create Network Interface
    console.log(`[/api/ExecDeployAVDSessionHost] Step 1: Creating NIC...`);
    const nicName = `${vmName}-nic`;
    const nicUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}?api-version=2023-09-01`;

    const nicPayload = {
      location,
      properties: {
        ipConfigurations: [{
          name: 'ipconfig1',
          properties: {
            subnet: { id: subnetId },
            privateIPAllocationMethod: 'Dynamic'
          }
        }]
      }
    };

    const nicResponse = await axios.put(nicUrl, nicPayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    results.push({
      resource: 'Network Interface',
      name: nicName,
      status: 'Created',
      id: nicResponse.data.id
    });

    // Step 2: Create the VM
    console.log(`[/api/ExecDeployAVDSessionHost] Step 2: Creating VM...`);
    const vmUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;

    const vmPayload = {
      location,
      properties: {
        hardwareProfile: {
          vmSize
        },
        storageProfile: {
          imageReference: imageReference || {
            publisher: 'MicrosoftWindowsDesktop',
            offer: 'Windows-11',
            sku: 'win11-23h2-avd',
            version: 'latest'
          },
          osDisk: {
            createOption: 'FromImage',
            managedDisk: {
              storageAccountType: 'Premium_LRS'
            }
          }
        },
        osProfile: {
          computerName: vmName.substring(0, 15), // Max 15 chars for Windows
          adminUsername,
          adminPassword,
          windowsConfiguration: {
            enableAutomaticUpdates: true,
            patchSettings: {
              patchMode: 'AutomaticByOS'
            }
          }
        },
        networkProfile: {
          networkInterfaces: [{
            id: nicResponse.data.id,
            properties: { primary: true }
          }]
        },
        licenseType: 'Windows_Client' // For Windows 11 multi-session
      },
      identity: {
        type: 'SystemAssigned'
      }
    };

    const vmResponse = await axios.put(vmUrl, vmPayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    results.push({
      resource: 'Virtual Machine',
      name: vmName,
      status: 'Creating',
      id: vmResponse.data.id
    });

    // Step 3: Add AVD extension (this installs the agent and registers with host pool)
    console.log(`[/api/ExecDeployAVDSessionHost] Step 3: Installing AVD agent extension...`);

    // Wait a bit for VM to be in a state where we can add extensions
    await new Promise(resolve => setTimeout(resolve, 30000));

    const extensionUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/extensions/Microsoft.PowerShell.DSC?api-version=2024-03-01`;

    const extensionPayload = {
      location,
      properties: {
        publisher: 'Microsoft.Powershell',
        type: 'DSC',
        typeHandlerVersion: '2.73',
        autoUpgradeMinorVersion: true,
        settings: {
          modulesUrl: 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.02714.342.zip',
          configurationFunction: 'Configuration.ps1\\AddSessionHost',
          properties: {
            hostPoolName: hostPoolName,
            registrationInfoTokenCredential: {
              UserName: 'PLACEHOLDER_DO_NOT_USE',
              Password: 'PrivateSettingsRef:RegistrationInfoToken'
            },
            aadJoin: !domainToJoin // Use AAD join if no domain specified
          }
        },
        protectedSettings: {
          Items: {
            RegistrationInfoToken: registrationToken
          }
        }
      }
    };

    // If domain join is specified, add domain join extension first
    if (domainToJoin && domainUsername && domainPassword) {
      console.log(`[/api/ExecDeployAVDSessionHost] Adding domain join extension...`);
      const domainJoinExtUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/extensions/JsonADDomainExtension?api-version=2024-03-01`;

      const domainJoinPayload = {
        location,
        properties: {
          publisher: 'Microsoft.Compute',
          type: 'JsonADDomainExtension',
          typeHandlerVersion: '1.3',
          autoUpgradeMinorVersion: true,
          settings: {
            Name: domainToJoin,
            User: domainUsername,
            Restart: 'true',
            Options: '3' // Join domain and create computer account
          },
          protectedSettings: {
            Password: domainPassword
          }
        }
      };

      try {
        await axios.put(domainJoinExtUrl, domainJoinPayload, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        results.push({
          resource: 'Domain Join Extension',
          name: 'JsonADDomainExtension',
          status: 'Installing'
        });

        // Wait for domain join to complete
        await new Promise(resolve => setTimeout(resolve, 60000));
      } catch (djError) {
        console.error(`[/api/ExecDeployAVDSessionHost] Domain join failed:`, djError.response?.data || djError.message);
        results.push({
          resource: 'Domain Join Extension',
          name: 'JsonADDomainExtension',
          status: 'Failed',
          error: djError.response?.data?.error?.message || djError.message
        });
      }
    }

    // Install AVD agent extension
    try {
      await axios.put(extensionUrl, extensionPayload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      results.push({
        resource: 'AVD Agent Extension',
        name: 'Microsoft.PowerShell.DSC',
        status: 'Installing'
      });
    } catch (extError) {
      console.error(`[/api/ExecDeployAVDSessionHost] AVD extension failed:`, extError.response?.data || extError.message);
      results.push({
        resource: 'AVD Agent Extension',
        name: 'Microsoft.PowerShell.DSC',
        status: 'Failed',
        error: extError.response?.data?.error?.message || extError.message
      });
    }

    console.log(`[/api/ExecDeployAVDSessionHost] Deployment initiated for ${vmName}`);

    return res.json({
      Results: `Session host deployment initiated for "${vmName}". The VM will appear in the host pool once the AVD agent installation completes (usually 5-10 minutes).`,
      severity: 'success',
      details: results,
      vmId: vmResponse.data.id
    });
  } catch (error) {
    console.error(`[/api/ExecDeployAVDSessionHost] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to deploy session host',
      message: error.response?.data?.error?.message || error.message,
      code: error.response?.data?.error?.code
    });
  }
});

/**
 * POST /api/ExecRegisterExistingVM
 * Register an existing VM as an AVD session host
 *
 * This installs the AVD agent on an existing VM and registers it with the host pool
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group of the VM (required)
 * - vmName: Name of the existing VM (required)
 * - hostPoolName: Host pool to join (required)
 * - registrationToken: AVD registration token (required)
 * - aadJoin: Use AAD join instead of AD join (default: true)
 */
router.post('/ExecRegisterExistingVM', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    vmName,
    hostPoolName,
    registrationToken,
    aadJoin = true
  } = req.body;

  console.log(`[/api/ExecRegisterExistingVM] Registering VM: ${vmName} to pool: ${hostPoolName}`);

  if (!subscriptionId || !resourceGroup || !vmName || !hostPoolName || !registrationToken) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['subscriptionId', 'resourceGroup', 'vmName', 'hostPoolName', 'registrationToken']
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    // First, get the VM to verify it exists and get its location
    const vmUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;

    const vmResponse = await axios.get(vmUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const location = vmResponse.data.location;

    // Install the AVD agent extension
    console.log(`[/api/ExecRegisterExistingVM] Installing AVD agent on ${vmName}...`);
    const extensionUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/extensions/Microsoft.PowerShell.DSC?api-version=2024-03-01`;

    const extensionPayload = {
      location,
      properties: {
        publisher: 'Microsoft.Powershell',
        type: 'DSC',
        typeHandlerVersion: '2.73',
        autoUpgradeMinorVersion: true,
        settings: {
          modulesUrl: 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.02714.342.zip',
          configurationFunction: 'Configuration.ps1\\AddSessionHost',
          properties: {
            hostPoolName: hostPoolName,
            registrationInfoTokenCredential: {
              UserName: 'PLACEHOLDER_DO_NOT_USE',
              Password: 'PrivateSettingsRef:RegistrationInfoToken'
            },
            aadJoin: aadJoin
          }
        },
        protectedSettings: {
          Items: {
            RegistrationInfoToken: registrationToken
          }
        }
      }
    };

    await axios.put(extensionUrl, extensionPayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[/api/ExecRegisterExistingVM] AVD agent extension installed on ${vmName}`);

    return res.json({
      Results: `AVD agent installation initiated on "${vmName}". The VM will appear in host pool "${hostPoolName}" once registration completes (usually 5-10 minutes).`,
      severity: 'success',
      vmName,
      hostPoolName
    });
  } catch (error) {
    console.error(`[/api/ExecRegisterExistingVM] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to register VM',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/GetAVDHostPoolRdpSettings
 * Get the custom RDP properties for a host pool
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 */
router.get('/GetAVDHostPoolRdpSettings', async (req, res) => {
  const { subscriptionId, resourceGroup, hostPoolName } = req.query;

  console.log(`[/api/GetAVDHostPoolRdpSettings] Getting RDP settings for: ${hostPoolName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and hostPoolName are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}?api-version=${AVD_API_VERSION}`;

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const customRdpProperty = response.data?.properties?.customRdpProperty || '';

    // Parse the RDP settings string into an object for easier manipulation
    // RDP settings have format: key:type:value (e.g., audiomode:i:0, drivestoredirect:s:)
    const rdpSettings = {};
    if (customRdpProperty) {
      customRdpProperty.split(';').forEach(setting => {
        if (!setting.trim()) return;

        // Split into at most 3 parts: key, type, value
        // Use regex to properly parse key:type:value format
        const match = setting.match(/^([^:]+):([is]):(.*)$/);
        if (match) {
          const [, key, type, rawValue] = match;
          rdpSettings[key.trim()] = {
            type,
            value: type === 'i' ? parseInt(rawValue, 10) || 0 : rawValue
          };
        } else {
          // Fallback for settings without type indicator
          const colonIndex = setting.indexOf(':');
          if (colonIndex > 0) {
            const key = setting.substring(0, colonIndex).trim();
            const value = setting.substring(colonIndex + 1);
            rdpSettings[key] = { type: 's', value };
          }
        }
      });
    }

    console.log(`[/api/GetAVDHostPoolRdpSettings] Retrieved RDP settings for ${hostPoolName}`);

    return res.json({
      Results: {
        hostPoolName,
        customRdpProperty,
        rdpSettings,
        // Common settings parsed for convenience
        parsed: {
          targetIsAadJoined: rdpSettings['targetisaadjoined']?.value === 1,
          enableRdsAadAuth: rdpSettings['enablerdsaadauth']?.value === 1,
          redirectClipboard: rdpSettings['redirectclipboard']?.value === 1,
          redirectPrinters: rdpSettings['redirectprinters']?.value === 1,
          redirectSmartCards: rdpSettings['redirectsmartcards']?.value === 1,
          redirectWebAuthn: rdpSettings['redirectwebauthn']?.value === 1,
          redirectLocation: rdpSettings['redirectlocation']?.value === 1,
          audioMode: rdpSettings['audiomode']?.value || 0,
          audioCaptureMode: rdpSettings['audiocapturemode']?.value || 0,
          videoPlaybackMode: rdpSettings['videoplaybackmode']?.value || 1,
          useMultimon: rdpSettings['use multimon']?.value === 1,
          autoReconnection: rdpSettings['autoreconnection enabled']?.value === 1,
          drivesToRedirect: rdpSettings['drivestoredirect']?.value || '',
          devicesToRedirect: rdpSettings['devicestoredirect']?.value || '',
          usbDevicesToRedirect: rdpSettings['usbdevicestoredirect']?.value || '',
          camerasToRedirect: rdpSettings['camerastoredirect']?.value || ''
        }
      }
    });
  } catch (error) {
    console.error(`[/api/GetAVDHostPoolRdpSettings] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to get RDP settings',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecUpdateAVDRdpSettings
 * Update the custom RDP properties for a host pool
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name (required)
 * - customRdpProperty: The full RDP property string (optional - use this OR rdpSettings)
 * - rdpSettings: Object with individual settings to merge (optional)
 */
router.post('/ExecUpdateAVDRdpSettings', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    customRdpProperty,
    rdpSettings
  } = req.body;

  console.log(`[/api/ExecUpdateAVDRdpSettings] Updating RDP settings for: ${hostPoolName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and hostPoolName are required'
    });
  }

  if (!customRdpProperty && !rdpSettings) {
    return res.status(400).json({
      error: 'Either customRdpProperty or rdpSettings is required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    let finalRdpProperty = customRdpProperty;

    // If rdpSettings object is provided, build the RDP property string
    if (rdpSettings && typeof rdpSettings === 'object') {
      const settingParts = [];
      for (const [key, config] of Object.entries(rdpSettings)) {
        if (config && typeof config === 'object' && 'type' in config && 'value' in config) {
          settingParts.push(`${key}:${config.type}:${config.value}`);
        } else {
          // Assume string type if not specified
          settingParts.push(`${key}:s:${config}`);
        }
      }
      finalRdpProperty = settingParts.join(';');
    }

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}?api-version=${AVD_API_VERSION}`;

    await axios.patch(url, {
      properties: {
        customRdpProperty: finalRdpProperty
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[/api/ExecUpdateAVDRdpSettings] Updated RDP settings for ${hostPoolName}`);

    return res.json({
      Results: 'RDP settings updated successfully',
      severity: 'success',
      hostPoolName,
      customRdpProperty: finalRdpProperty
    });
  } catch (error) {
    console.error(`[/api/ExecUpdateAVDRdpSettings] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to update RDP settings',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAVDRemoteApps
 * List RemoteApp applications in an application group
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - appGroupName: Application group name (required)
 */
router.get('/ListAVDRemoteApps', async (req, res) => {
  const { subscriptionId, resourceGroup, appGroupName } = req.query;

  console.log(`[/api/ListAVDRemoteApps] Listing apps for: ${appGroupName}`);

  if (!subscriptionId || !resourceGroup || !appGroupName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and appGroupName are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${appGroupName}/applications?api-version=${AVD_API_VERSION}`;

    console.log(`[/api/ListAVDRemoteApps] Fetching from: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const apps = (response.data.value || []).map(app => ({
      id: app.id,
      name: app.name,
      friendlyName: app.properties?.friendlyName || app.name,
      description: app.properties?.description,
      filePath: app.properties?.filePath,
      iconPath: app.properties?.iconPath,
      iconIndex: app.properties?.iconIndex,
      commandLineSetting: app.properties?.commandLineSetting,
      commandLineArguments: app.properties?.commandLineArguments,
      showInPortal: app.properties?.showInPortal,
      applicationType: app.properties?.applicationType
    }));

    console.log(`[/api/ListAVDRemoteApps] Found ${apps.length} applications`);

    return res.json({
      Results: apps,
      Metadata: {
        appGroupName,
        count: apps.length
      }
    });
  } catch (error) {
    console.error(`[/api/ListAVDRemoteApps] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to list applications',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecCreateAVDRemoteApp
 * Create a RemoteApp application in an application group
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - appGroupName: Application group name (required)
 * - appName: Application name (required)
 * - friendlyName: Display name
 * - description: Description
 * - filePath: Path to the executable
 * - iconPath: Path to the icon
 * - iconIndex: Icon index (default: 0)
 * - commandLineSetting: Allow, DoNotAllow, or Require
 * - commandLineArguments: Default command line arguments
 */
router.post('/ExecCreateAVDRemoteApp', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    appGroupName,
    appName,
    friendlyName,
    description,
    filePath,
    iconPath,
    iconIndex = 0,
    commandLineSetting = 'DoNotAllow',
    commandLineArguments = ''
  } = req.body;

  console.log(`[/api/ExecCreateAVDRemoteApp] Creating app: ${appName} in ${appGroupName}`);

  if (!subscriptionId || !resourceGroup || !appGroupName || !appName || !filePath) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, appGroupName, appName, and filePath are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${appGroupName}/applications/${appName}?api-version=${AVD_API_VERSION}`;

    const payload = {
      properties: {
        friendlyName: friendlyName || appName,
        description: description || '',
        filePath: filePath,
        iconPath: iconPath || filePath,
        iconIndex: iconIndex,
        commandLineSetting: commandLineSetting,
        commandLineArguments: commandLineArguments,
        showInPortal: true,
        applicationType: 'InBuilt'
      }
    };

    await axios.put(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[/api/ExecCreateAVDRemoteApp] Created app: ${appName}`);

    return res.json({
      Results: `Application "${friendlyName || appName}" created successfully`,
      severity: 'success',
      appName,
      appGroupName
    });
  } catch (error) {
    console.error(`[/api/ExecCreateAVDRemoteApp] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to create application',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecDeleteAVDRemoteApp
 * Delete a RemoteApp application from an application group
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - appGroupName: Application group name (required)
 * - appName: Application name (required)
 */
router.post('/ExecDeleteAVDRemoteApp', async (req, res) => {
  const { subscriptionId, resourceGroup, appGroupName, appName } = req.body;

  console.log(`[/api/ExecDeleteAVDRemoteApp] Deleting app: ${appName} from ${appGroupName}`);

  if (!subscriptionId || !resourceGroup || !appGroupName || !appName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, appGroupName, and appName are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${appGroupName}/applications/${appName}?api-version=${AVD_API_VERSION}`;

    await axios.delete(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[/api/ExecDeleteAVDRemoteApp] Deleted app: ${appName}`);

    return res.json({
      Results: `Application "${appName}" deleted successfully`,
      severity: 'success',
      appName,
      appGroupName
    });
  } catch (error) {
    console.error(`[/api/ExecDeleteAVDRemoteApp] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to delete application',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * POST /api/ExecCreateAVDRemoteAppGroup
 * Create a RemoteApp application group with common Microsoft 365 apps
 *
 * Body params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - hostPoolName: Host pool name to associate with (required)
 * - appGroupName: Application group name (required)
 * - friendlyName: Display name
 * - description: Description
 * - location: Azure region
 * - apps: Array of app names to add (excel, word, edge, outlook, onedrive, powerpoint, teams, onenote)
 */
router.post('/ExecCreateAVDRemoteAppGroup', async (req, res) => {
  const {
    subscriptionId,
    resourceGroup,
    hostPoolName,
    appGroupName,
    friendlyName,
    description,
    location = 'usgovvirginia',
    apps = []
  } = req.body;

  console.log(`[/api/ExecCreateAVDRemoteAppGroup] Creating RemoteApp group: ${appGroupName}`);

  if (!subscriptionId || !resourceGroup || !hostPoolName || !appGroupName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, hostPoolName, and appGroupName are required'
    });
  }

  // Define common Microsoft 365 app paths
  const commonApps = {
    excel: {
      name: 'Excel',
      friendlyName: 'Microsoft Excel',
      filePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      iconPath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE'
    },
    word: {
      name: 'Word',
      friendlyName: 'Microsoft Word',
      filePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
      iconPath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'
    },
    edge: {
      name: 'Edge',
      friendlyName: 'Microsoft Edge',
      filePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      iconPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    },
    outlook: {
      name: 'Outlook',
      friendlyName: 'Microsoft Outlook (Classic)',
      filePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE',
      iconPath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE'
    },
    onedrive: {
      name: 'OneDrive',
      friendlyName: 'Microsoft OneDrive',
      filePath: 'C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe',
      iconPath: 'C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe'
    },
    powerpoint: {
      name: 'PowerPoint',
      friendlyName: 'Microsoft PowerPoint',
      filePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
      iconPath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE'
    },
    teams: {
      name: 'Teams',
      friendlyName: 'Microsoft Teams',
      filePath: 'C:\\Program Files\\WindowsApps\\MSTeams_24004.1307.2669.7070_x64__8wekyb3d8bbwe\\ms-teams.exe',
      iconPath: 'C:\\Program Files\\WindowsApps\\MSTeams_24004.1307.2669.7070_x64__8wekyb3d8bbwe\\ms-teams.exe'
    },
    onenote: {
      name: 'OneNote',
      friendlyName: 'Microsoft OneNote',
      filePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\ONENOTE.EXE',
      iconPath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\ONENOTE.EXE'
    }
  };

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    // Step 1: Create the RemoteApp Application Group
    const appGroupUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${appGroupName}?api-version=${AVD_API_VERSION}`;

    const hostPoolArmPath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}`;

    const appGroupPayload = {
      location: location,
      properties: {
        hostPoolArmPath: hostPoolArmPath,
        applicationGroupType: 'RemoteApp',
        friendlyName: friendlyName || appGroupName,
        description: description || 'RemoteApp application group'
      }
    };

    console.log(`[/api/ExecCreateAVDRemoteAppGroup] Creating app group at: ${appGroupUrl}`);

    await axios.put(appGroupUrl, appGroupPayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[/api/ExecCreateAVDRemoteAppGroup] App group created, adding applications...`);

    // Step 2: Add the requested applications
    const createdApps = [];
    const failedApps = [];

    for (const appKey of apps) {
      const appConfig = commonApps[appKey.toLowerCase()];
      if (!appConfig) {
        failedApps.push({ app: appKey, error: 'Unknown app' });
        continue;
      }

      try {
        const appUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups/${appGroupName}/applications/${appConfig.name}?api-version=${AVD_API_VERSION}`;

        const appPayload = {
          properties: {
            friendlyName: appConfig.friendlyName,
            description: `${appConfig.friendlyName} RemoteApp`,
            filePath: appConfig.filePath,
            iconPath: appConfig.iconPath,
            iconIndex: 0,
            commandLineSetting: 'DoNotAllow',
            showInPortal: true,
            applicationType: 'InBuilt'
          }
        };

        await axios.put(appUrl, appPayload, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        createdApps.push(appConfig.friendlyName);
      } catch (appError) {
        failedApps.push({
          app: appConfig.friendlyName,
          error: appError.response?.data?.error?.message || appError.message
        });
      }
    }

    console.log(`[/api/ExecCreateAVDRemoteAppGroup] Created ${createdApps.length} apps, ${failedApps.length} failed`);

    return res.json({
      Results: `RemoteApp group "${friendlyName || appGroupName}" created successfully with ${createdApps.length} applications`,
      severity: failedApps.length > 0 ? 'warning' : 'success',
      appGroupName,
      createdApps,
      failedApps: failedApps.length > 0 ? failedApps : undefined
    });
  } catch (error) {
    console.error(`[/api/ExecCreateAVDRemoteAppGroup] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to create RemoteApp group',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListVMExtensions
 * List VM extensions to show registration progress
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group of the VM (required)
 * - vmName: Name of the VM (required)
 */
router.get('/ListVMExtensions', async (req, res) => {
  const { subscriptionId, resourceGroup, vmName } = req.query;

  console.log(`[/api/ListVMExtensions] Getting extensions for VM: ${vmName}`);

  if (!subscriptionId || !resourceGroup || !vmName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and vmName are required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    const url = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/extensions?api-version=2024-03-01`;

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const extensions = (response.data.value || []).map(ext => ({
      name: ext.name,
      type: ext.properties?.type,
      publisher: ext.properties?.publisher,
      provisioningState: ext.properties?.provisioningState,
      instanceView: ext.properties?.instanceView
    }));

    // Find the DSC extension (AVD agent)
    const dscExtension = extensions.find(e => e.type === 'DSC' || e.name === 'Microsoft.PowerShell.DSC');

    console.log(`[/api/ListVMExtensions] Found ${extensions.length} extensions for ${vmName}`);

    return res.json({
      Results: {
        vmName,
        extensions,
        avdAgentStatus: dscExtension ? {
          installed: true,
          provisioningState: dscExtension.provisioningState,
          status: dscExtension.instanceView?.statuses?.[0]?.displayStatus || dscExtension.provisioningState
        } : {
          installed: false,
          provisioningState: null,
          status: 'Not Installed'
        }
      }
    });
  } catch (error) {
    console.error(`[/api/ListVMExtensions] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to get VM extensions',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListPendingAVDRegistrations
 * List VMs that have the AVD DSC extension in a pending/creating state
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - hostPoolName: Optional host pool name to filter by
 * - resourceGroup: Optional resource group of the host pool
 */
router.get('/ListPendingAVDRegistrations', async (req, res) => {
  const { subscriptionId, hostPoolName, resourceGroup } = req.query;

  console.log(`[/api/ListPendingAVDRegistrations] Getting pending registrations for subscription: ${subscriptionId}, hostPool: ${hostPoolName}`);

  if (!subscriptionId) {
    return res.status(400).json({
      error: 'subscriptionId is required'
    });
  }

  try {
    const accessToken = await getArmAccessToken(resolveTenantFilterFromReq(req));
    const managementEndpoint = getAzureManagementEndpoint();

    // If hostPoolName is provided, get existing session hosts to exclude already-registered VMs
    let existingSessionHosts = new Set();
    if (hostPoolName && resourceGroup) {
      try {
        const sessionHostsUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/sessionHosts?api-version=2024-04-03`;
        const sessionHostsResponse = await axios.get(sessionHostsUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const hosts = sessionHostsResponse.data.value || [];
        // Session host names are like "poolname/vmname.domain.com" - extract just the VM name
        hosts.forEach(h => {
          const nameParts = h.name.split('/');
          if (nameParts.length > 1) {
            const vmFqdn = nameParts[1];
            const vmName = vmFqdn.split('.')[0]; // Get just the hostname part
            existingSessionHosts.add(vmName.toLowerCase());
          }
        });
        console.log(`[/api/ListPendingAVDRegistrations] Existing session hosts: ${Array.from(existingSessionHosts).join(', ')}`);
      } catch (err) {
        console.log(`[/api/ListPendingAVDRegistrations] Could not fetch existing session hosts: ${err.message}`);
      }
    }

    // Get all VMs in the subscription
    const vmsUrl = `${managementEndpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-03-01`;

    const vmsResponse = await axios.get(vmsUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const vms = vmsResponse.data.value || [];

    // Filter out VMs that are already registered as session hosts
    const vmsToCheck = vms.filter(vm => !existingSessionHosts.has(vm.name.toLowerCase()));

    console.log(`[/api/ListPendingAVDRegistrations] Checking ${vmsToCheck.length} VMs (${vms.length - vmsToCheck.length} already registered)`);

    // Check extensions in parallel for better performance
    const extensionChecks = await Promise.allSettled(
      vmsToCheck.map(async (vm) => {
        try {
          const extUrl = `${managementEndpoint}${vm.id}/extensions?api-version=2024-03-01`;
          const extResponse = await axios.get(extUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          return { vm, extensions: extResponse.data.value || [] };
        } catch (err) {
          return { vm, extensions: [], error: err.message };
        }
      })
    );

    const pendingRegistrations = [];

    for (const result of extensionChecks) {
      if (result.status !== 'fulfilled') continue;

      const { vm, extensions, error } = result.value;
      if (error) {
        console.log(`[/api/ListPendingAVDRegistrations] Skipping VM ${vm.name}: ${error}`);
        continue;
      }

      const dscExt = extensions.find(e => e.properties?.type === 'DSC' || e.name === 'Microsoft.PowerShell.DSC');

      if (dscExt) {
        const state = dscExt.properties?.provisioningState;
        const targetHostPool = dscExt.properties?.settings?.properties?.hostPoolName;

        // Only include if targeting the specified host pool (if provided)
        if (hostPoolName && targetHostPool && targetHostPool.toLowerCase() !== hostPoolName.toLowerCase()) {
          console.log(`[/api/ListPendingAVDRegistrations] Skipping ${vm.name} - targets different host pool: ${targetHostPool}`);
          continue;
        }

        console.log(`[/api/ListPendingAVDRegistrations] VM ${vm.name} DSC extension: provisioningState=${state}, targetHostPool=${targetHostPool}`);

        // Only include VMs where the extension is NOT in a terminal state
        // Succeeded and Failed are terminal states - registration is complete (or failed)
        const isInProgress = state !== 'Succeeded' && state !== 'Failed';

        if (isInProgress) {
          // Extract resource group from VM ID
          const rgMatch = vm.id.match(/resourceGroups\/([^/]+)/i);
          pendingRegistrations.push({
            vmName: vm.name,
            resourceGroup: rgMatch ? rgMatch[1] : 'Unknown',
            location: vm.location,
            provisioningState: state,
            extensionStatus: dscExt.properties?.instanceView?.statuses?.[0]?.displayStatus || state,
            vmSize: vm.properties?.hardwareProfile?.vmSize,
            startTime: dscExt.properties?.instanceView?.statuses?.[0]?.time || null,
            targetHostPool: targetHostPool
          });
        }
      }
    }

    console.log(`[/api/ListPendingAVDRegistrations] Found ${pendingRegistrations.length} pending registrations`);

    return res.json({
      Results: pendingRegistrations
    });
  } catch (error) {
    console.error(`[/api/ListPendingAVDRegistrations] Error:`, error.response?.data || error.message);

    return res.status(500).json({
      error: 'Failed to get pending registrations',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

/**
 * GET /api/ListAzureComputeGalleries
 * List Shared Image Galleries in a resource group
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 */
router.get('/ListAzureComputeGalleries', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query;
  const requestedTenant = resolveTenantFilterFromReq(req);

  if (!requestedTenant) {
    return res.status(400).json({
      error: 'tenantFilter is required',
      Results: []
    });
  }

  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({
      error: 'subscriptionId and resourceGroup are required',
      Results: []
    });
  }

  try {
    const accessToken = await getArmAccessToken(requestedTenant);
    const managementEndpoint = getAzureManagementEndpoint();

    const galleries = await listGalleriesForResourceGroup(subscriptionId, resourceGroup, accessToken, managementEndpoint);
    const results = galleries.map((gallery) => ({
      id: gallery.id,
      name: gallery.name,
      location: gallery.location,
      label: `${gallery.name} (${gallery.location})`,
      value: gallery.name
    }));

    return res.json({
      Results: results,
      Metadata: {
        count: results.length,
        subscriptionId,
        resourceGroup
      }
    });
  } catch (error) {
    console.error(`[/api/ListAzureComputeGalleries] Error:`, error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to list compute galleries',
      message: error.response?.data?.error?.message || error.message,
      Results: []
    });
  }
});

/**
 * GET /api/ListAzureGalleryImageDefinitions
 * List image definitions in a Shared Image Gallery
 *
 * Query params:
 * - subscriptionId: Azure subscription ID (required)
 * - resourceGroup: Resource group name (required)
 * - galleryName: Shared Image Gallery name (required)
 */
router.get('/ListAzureGalleryImageDefinitions', async (req, res) => {
  const { subscriptionId, resourceGroup, galleryName } = req.query;
  const requestedTenant = resolveTenantFilterFromReq(req);

  if (!requestedTenant) {
    return res.status(400).json({
      error: 'tenantFilter is required',
      Results: []
    });
  }

  if (!subscriptionId || !resourceGroup || !galleryName) {
    return res.status(400).json({
      error: 'subscriptionId, resourceGroup, and galleryName are required',
      Results: []
    });
  }

  try {
    const accessToken = await getArmAccessToken(requestedTenant);
    const managementEndpoint = getAzureManagementEndpoint();
    const definitions = await listGalleryDefinitions(subscriptionId, resourceGroup, galleryName, accessToken, managementEndpoint);

    const results = definitions.map((def) => ({
      id: def.id,
      name: def.name,
      osType: def.properties?.osType,
      osState: def.properties?.osState,
      identifier: def.properties?.identifier || {},
      label: `${def.name} (${def.properties?.identifier?.publisher || 'n/a'}/${def.properties?.identifier?.offer || 'n/a'}/${def.properties?.identifier?.sku || 'n/a'})`,
      value: def.name
    }));

    return res.json({
      Results: results,
      Metadata: {
        count: results.length,
        subscriptionId,
        resourceGroup,
        galleryName
      }
    });
  } catch (error) {
    console.error(`[/api/ListAzureGalleryImageDefinitions] Error:`, error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to list gallery image definitions',
      message: error.response?.data?.error?.message || error.message,
      Results: []
    });
  }
});

/**
 * POST /api/ResolveAVDWorkflowConfiguration
 * Resolve and auto-populate AVD workflow configuration from Azure lookups.
 *
 * Body params:
 * - config: Partial workflow config (optional)
 * - stages: Stage array or "All" (optional)
 */
router.post('/ResolveAVDWorkflowConfiguration', async (req, res) => {
  const requestedTenant = resolveTenantFilterFromReq(req);
  const { config = {}, stages = ['All'] } = req.body || {};

  if (!requestedTenant) {
    return res.status(400).json({
      error: 'tenantFilter is required',
      Results: null
    });
  }

  try {
    const expectedTenantId = requestedTenant ? await normalizeTenantId(requestedTenant) : null;
    const accessToken = await getArmAccessToken(requestedTenant);
    const managementEndpoint = getAzureManagementEndpoint();

    const resolution = await resolveAvdWorkflowConfiguration({
      partialConfig: config,
      stages,
      accessToken,
      managementEndpoint,
      expectedTenantId
    });

    return res.json({
      Results: {
        resolvedConfig: resolution.resolvedConfig,
        effectiveStages: resolution.effectiveStages,
        missingSelections: resolution.missingSelections,
        warnings: resolution.warnings,
        options: resolution.options
      }
    });
  } catch (error) {
    console.error(`[/api/ResolveAVDWorkflowConfiguration] Error:`, error.response?.data || error.message);
    const message = error.response?.data?.error?.message || error.message;
    const status = error.code === 'InvalidStages' ? 400 : 500;

    return res.status(status).json({
      error: 'Failed to resolve AVD workflow configuration',
      message,
      Results: null
    });
  }
});

/**
 * POST /api/ExecRunAVDNativeWorkflow
 * Execute native AVD workflow stages (no PowerShell wrapper).
 *
 * Body params:
 * - config: Workflow config object (optional)
 * - stages: Stage array or "All" (optional)
 * - dryRun: true to return resolved configuration and required selections only (optional)
 */
router.post('/ExecRunAVDNativeWorkflow', async (req, res) => {
  const requestedTenant = resolveTenantFilterFromReq(req);
  const { config = {}, stages = ['All'], dryRun = false } = req.body || {};

  if (!requestedTenant) {
    return res.status(400).json({
      error: 'tenantFilter is required'
    });
  }

  try {
    const expectedTenantId = requestedTenant ? await normalizeTenantId(requestedTenant) : null;
    const accessToken = await getArmAccessToken(requestedTenant);
    const managementEndpoint = getAzureManagementEndpoint();

    const resolution = await resolveAvdWorkflowConfiguration({
      partialConfig: config,
      stages,
      accessToken,
      managementEndpoint,
      expectedTenantId
    });

    const missingRequired = validateWorkflowRequirements(
      resolution.resolvedConfig,
      resolution.effectiveStages
    );

    const unresolved = [...new Set([...resolution.missingSelections, ...missingRequired])];
    if (unresolved.length > 0) {
      return res.status(409).json({
        error: 'Workflow configuration requires additional selections',
        message: `Provide values for: ${unresolved.join(', ')}`,
        Results: {
          resolvedConfig: resolution.resolvedConfig,
          effectiveStages: resolution.effectiveStages,
          missingSelections: unresolved,
          warnings: resolution.warnings,
          options: resolution.options
        }
      });
    }

    if (dryRun) {
      return res.json({
        Results: {
          dryRun: true,
          resolvedConfig: resolution.resolvedConfig,
          effectiveStages: resolution.effectiveStages,
          warnings: resolution.warnings,
          options: resolution.options
        }
      });
    }

    const execution = await executeAvdNativeWorkflow({
      config: resolution.resolvedConfig,
      effectiveStages: resolution.effectiveStages,
      accessToken,
      managementEndpoint
    });

    return res.json({
      Results: 'AVD native workflow completed successfully.',
      severity: 'success',
      effectiveStages: resolution.effectiveStages,
      resolvedConfig: resolution.resolvedConfig,
      warnings: resolution.warnings,
      details: execution.details,
      validation: execution.validation
    });
  } catch (error) {
    console.error(`[/api/ExecRunAVDNativeWorkflow] Error:`, error.response?.data || error.message);

    const status =
      error.code === 'InvalidStages'
        ? 400
        : error.code === 'SubnetNotFound'
          ? 400
          : error.code === 'RegistrationTokenFailed'
            ? 500
            : isConflictError(error)
              ? 409
              : 500;

    return res.status(status).json({
      error: 'Failed to execute native AVD workflow',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

router.__test__ = {
  ALWAYS_REQUIRED_WORKFLOW_FIELDS,
  WORKFLOW_STAGE_REQUIREMENTS,
  normalizeWorkflowConfig,
  resolveWorkflowStages,
  validateWorkflowRequirements
};

module.exports = router;
