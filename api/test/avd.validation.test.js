const test = require('node:test');
const assert = require('node:assert/strict');

const avdRoutes = require('../src/routes/avd');

const {
  normalizeWorkflowConfig,
  resolveWorkflowStages,
  validateWorkflowRequirements
} = avdRoutes.__test__;

function getBaseWorkflowConfig(overrides = {}) {
  return normalizeWorkflowConfig({
    subscriptionId: 'sub-123',
    location: 'usgovvirginia',
    imageResourceGroup: 'rg-images',
    hostPoolResourceGroup: 'rg-avd',
    vnetResourceGroup: 'rg-network',
    vnetName: 'vnet-avd',
    sessionHostSubnetName: 'sn-avd',
    baseVmName: 'avd-gold-base-01',
    localAdminUsername: 'avdadmin',
    localAdminPassword: 'super-secret-password',
    galleryName: 'sig-avd-gold',
    galleryImageDefinitionName: 'avd-gold-base',
    galleryImageVersion: '1.0.0',
    hostPoolName: 'avd-cui-hp',
    workspaceName: 'avd-cui-ws',
    desktopAppGroupName: 'avd-cui-dag',
    ...overrides
  });
}

test('DeploySessionHosts requires imageResourceGroup when deploying from a captured image', () => {
  const config = getBaseWorkflowConfig({ imageResourceGroup: '' });

  const missing = validateWorkflowRequirements(
    config,
    resolveWorkflowStages(['DeploySessionHosts'])
  );

  assert.equal(missing.includes('imageResourceGroup'), true);
});

test('Validate requires imageResourceGroup when checking gallery image state', () => {
  const config = getBaseWorkflowConfig({ imageResourceGroup: '' });

  const missing = validateWorkflowRequirements(
    config,
    resolveWorkflowStages(['Validate'])
  );

  assert.equal(missing.includes('imageResourceGroup'), true);
});

test('CreateHostPool does not require imageResourceGroup', () => {
  const config = getBaseWorkflowConfig({ imageResourceGroup: '' });

  const missing = validateWorkflowRequirements(
    config,
    resolveWorkflowStages(['CreateHostPool'])
  );

  assert.equal(missing.includes('imageResourceGroup'), false);
});
