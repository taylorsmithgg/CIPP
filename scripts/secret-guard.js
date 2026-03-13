#!/usr/bin/env node

const { execFileSync } = require('node:child_process');

const args = new Set(process.argv.slice(2));

const BLOCKED_PATH_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^api\/local\.settings(?:\..*)?\.json$/i,
  /^test-credentials\.json$/i,
  /^tmp-.*\.json$/i,
];

const HIGH_CONFIDENCE_PATTERNS = [
  {
    id: 'azure-storage-connection-string',
    description: 'Azure storage connection string',
    regex: /DefaultEndpointsProtocol=.*AccountKey=/i,
  },
  {
    id: 'private-key',
    description: 'private key material',
    regex: /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PRIVATE KEY)-----/,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    regex: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/,
  },
  {
    id: 'bearer-jwt',
    description: 'bearer token',
    regex: /Bearer\s+eyJ[A-Za-z0-9._-]{20,}/,
  },
  {
    id: 'sas-token',
    description: 'shared access signature',
    regex: /SharedAccessSignature=/i,
  },
];

const KEY_VALUE_PREFIX = /\b(ApplicationSecret|AzureWebJobsStorage|RefreshToken|access_token|client_secret|password|B2B_API_KEY|LocalAdminPasswordPlaintext)\b\s*[:=]\s*(.+)$/i;

const SAFE_VALUE_PATTERNS = [
  /^["']?<[^>]+>["']?$/,
  /^["']?\.\.\.["']?$/,
  /^["']?\$[A-Z_][A-Z0-9_]*["']?$/i,
  /^["']?(?:REPLACE_ME|LongApplicationSecret|changeme|placeholder|example|sample|dummy|fake|test|super-secret-password)["']?$/i,
  /^["']?PrivateSettingsRef:[A-Za-z0-9._-]+["']?$/,
  /^[A-Za-z_$][A-Za-z0-9_.$]*$/,
  /@Microsoft\.KeyVault\(/,
  /\bprocess\.env\./,
  /\bsamCreds\./,
  /\bconfig\./,
  /\bresponse\./,
  /\breq\./,
  /\bres\./,
  /\bbody\./,
  /\btokenData\./,
  /\baccessToken\b/,
  /\brefreshToken\b/,
  /\bclientSecret\b/,
  /\bapplicationSecret\b/,
];

function runGit(argsToRun) {
  return execFileSync('git', argsToRun, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function splitLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

function stripWrappingQuotes(value) {
  const trimmed = value.trim().replace(/[;,]$/, '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function looksLikeSafeValue(rawValue) {
  const value = stripWrappingQuotes(rawValue);
  if (!value || value.length < 8) {
    return true;
  }

  return SAFE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function scanPaths(paths) {
  const findings = [];

  for (const filePath of paths) {
    if (BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(filePath))) {
      findings.push({
        type: 'path',
        filePath,
        description: 'blocked sensitive local file',
      });
    }
  }

  return findings;
}

function scanDiff(diffText) {
  const findings = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }

    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    const addedLine = line.slice(1);
    const trimmedLine = addedLine.trim();

    if (currentFile === 'scripts/secret-guard.js') {
      continue;
    }

    if (
      trimmedLine.startsWith('*')
      || trimmedLine.startsWith('//')
      || trimmedLine.startsWith('#')
    ) {
      continue;
    }

    for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
      if (pattern.regex.test(addedLine)) {
        findings.push({
          type: 'content',
          filePath: currentFile,
          description: pattern.description,
          line: addedLine.trim(),
        });
      }
    }

    const match = addedLine.match(KEY_VALUE_PREFIX);
    if (!match) {
      continue;
    }

    const [, keyName, rawValue] = match;
    if (looksLikeSafeValue(rawValue)) {
      continue;
    }

    findings.push({
      type: 'content',
      filePath: currentFile,
      description: `literal value assigned to ${keyName}`,
      line: addedLine.trim(),
    });
  }

  return findings;
}

function getStagedState() {
  return {
    paths: splitLines(runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])),
    diff: runGit(['diff', '--cached', '--unified=0', '--no-ext-diff', '--text', '--no-color']),
  };
}

function getCommitState(commits) {
  const paths = new Set();
  const diffs = [];

  for (const commit of commits) {
    splitLines(runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit]))
      .forEach((filePath) => paths.add(filePath));
    diffs.push(runGit(['show', '--format=', '--unified=0', '--no-ext-diff', '--text', '--no-color', commit]));
  }

  return {
    paths: [...paths],
    diff: diffs.join('\n'),
  };
}

function printFindings(findings) {
  console.error('Secret guard blocked this operation.');
  console.error('Remove the sensitive file or secret before committing/pushing.');
  console.error('');

  for (const finding of findings.slice(0, 20)) {
    const location = finding.filePath ? ` [${finding.filePath}]` : '';
    console.error(`- ${finding.description}${location}`);
    if (finding.line) {
      console.error(`  ${finding.line}`);
    }
  }

  if (findings.length > 20) {
    console.error(`- ${findings.length - 20} additional finding(s) omitted`);
  }

  console.error('');
  console.error('Common fixes:');
  console.error('- keep local secrets in ignored files like api/local.settings.json or .env.local only');
  console.error('- replace real values with placeholders or Key Vault references before staging');
  console.error('- use `git reset HEAD <file>` if you staged a sensitive file by mistake');
}

async function main() {
  let state;

  if (args.has('--staged')) {
    state = getStagedState();
  } else if (args.has('--commits-from-stdin')) {
    const stdinData = await readStdin();
    const commits = splitLines(stdinData);
    if (commits.length === 0) {
      process.exit(0);
    }
    state = getCommitState(commits);
  } else {
    console.error('Usage: node scripts/secret-guard.js --staged | --commits-from-stdin');
    process.exit(2);
  }

  const findings = [
    ...scanPaths(state.paths),
    ...scanDiff(state.diff),
  ];

  if (findings.length > 0) {
    printFindings(findings);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Secret guard failed: ${error.message}`);
  process.exit(1);
});
