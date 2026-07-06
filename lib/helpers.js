#!/usr/bin/env node
/**
 * Helper functions for common Bitbucket pipeline operations
 * These provide intuitive, high-level wrappers around the CLI
 */

import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Execute CLI command and return parsed JSON result
 */
function runCli(args) {
  const cliPath = join(__dirname, '..', 'bitbucket-mcp', 'dist', 'index-cli.js');
  const command = `node "${cliPath}" ${args}`;

  try {
    const output = execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] , maxBuffer: 100 * 1024 * 1024 });
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`CLI command failed: ${error.message}\n${error.stderr || ''}`);
  }
}

/**
 * Execute CLI command and return raw text result (for logs)
 */
function runCliText(args) {
  const cliPath = join(__dirname, '..', 'bitbucket-mcp', 'dist', 'index-cli.js');
  const command = `node "${cliPath}" ${args}`;

  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] , maxBuffer: 100 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`CLI command failed: ${error.message}\n${error.stderr || ''}`);
  }
}

/**
 * Get the latest failed pipeline for a repository
 */
export function getLatestFailedPipeline(workspace, repo) {
  const result = runCli(`list-pipelines "${workspace}" "${repo}" 1 FAILED`);

  if (!result.values || result.values.length === 0) {
    return null;
  }

  return result.values[0];
}

/**
 * Get the latest pipeline (any status) for a repository
 */
export function getLatestPipeline(workspace, repo) {
  const result = runCli(`list-pipelines "${workspace}" "${repo}" 1`);

  if (!result.values || result.values.length === 0) {
    return null;
  }

  return result.values[0];
}

/**
 * Get pipeline details by build number
 * Note: Requires looking up UUID first
 */
export function getPipelineByNumber(workspace, repo, buildNumber) {
  // List recent pipelines to find the UUID
  const result = runCli(`list-pipelines "${workspace}" "${repo}" 50`);

  const pipeline = result.values?.find(p => p.build_number === parseInt(buildNumber));

  if (!pipeline) {
    throw new Error(`Pipeline #${buildNumber} not found in recent pipelines`);
  }

  return pipeline;
}

/**
 * Get all steps for a pipeline
 */
export function getPipelineSteps(workspace, repo, pipelineUuid) {
  return runCli(`get-pipeline-steps "${workspace}" "${repo}" "${pipelineUuid}"`);
}

/**
 * Get only the failed steps from a pipeline
 */
export function getFailedSteps(workspace, repo, pipelineUuid) {
  const steps = runCli(`get-pipeline-steps "${workspace}" "${repo}" "${pipelineUuid}"`);

  if (!steps.values) {
    return [];
  }

  return steps.values.filter(step =>
    step.state?.result?.name === 'FAILED' || step.state?.result?.name === 'ERROR'
  );
}

/**
 * Download logs for a specific step
 */
export function downloadStepLogs(workspace, repo, pipelineUuid, stepUuid) {
  return runCliText(`get-step-logs "${workspace}" "${repo}" "${pipelineUuid}" "${stepUuid}"`);
}

/**
 * Download logs for all failed steps and save to project directory
 * Returns array of objects with step info and log file path
 */
export function downloadFailedStepLogs(workspace, repo, pipelineUuid, buildNumber) {
  const failedSteps = getFailedSteps(workspace, repo, pipelineUuid);

  if (failedSteps.length === 0) {
    return [];
  }

  // Create .pipeline-logs directory in current working directory
  const logDir = join(process.cwd(), '.pipeline-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const results = [];

  for (const step of failedSteps) {
    const stepName = step.name || 'unnamed';
    const safeStepName = stepName.replace(/[^a-z0-9-]/gi, '_');
    const logFileName = `pipeline-${buildNumber}-${safeStepName}.log`;
    const logFilePath = join(logDir, logFileName);

    try {
      const logs = downloadStepLogs(workspace, repo, pipelineUuid, step.uuid);
      fs.writeFileSync(logFilePath, logs);

      results.push({
        stepName,
        stepUuid: step.uuid,
        logFilePath,
        size: logs.length,
        status: step.state?.result?.name
      });
    } catch (error) {
      console.error(`Failed to download logs for step ${stepName}:`, error.message);
    }
  }

  return results;
}

/**
 * Get pipeline info with friendly formatting
 */
export function getPipelineInfo(workspace, repo, pipelineUuid) {
  const pipeline = runCli(`get-pipeline "${workspace}" "${repo}" "${pipelineUuid}"`);
  const steps = runCli(`get-pipeline-steps "${workspace}" "${repo}" "${pipelineUuid}"`);

  return {
    buildNumber: pipeline.build_number,
    status: pipeline.state?.name,
    branch: pipeline.target?.ref_name,
    commit: {
      hash: pipeline.target?.commit?.hash?.substring(0, 7),
      message: pipeline.target?.commit?.message
    },
    createdOn: pipeline.created_on,
    completedOn: pipeline.completed_on,
    durationSeconds: pipeline.duration_in_seconds,
    steps: steps.values?.map(step => ({
      name: step.name,
      status: step.state?.name,
      result: step.state?.result?.name,
      durationSeconds: step.duration_in_seconds
    })) || []
  };
}

/**
 * Trigger a pipeline run
 */
export function triggerPipeline(workspace, repo, branch, customPipeline = null) {
  const args = customPipeline
    ? `run-pipeline "${workspace}" "${repo}" "${branch}" "${customPipeline}"`
    : `run-pipeline "${workspace}" "${repo}" "${branch}"`;

  return runCli(args);
}

/**
 * Stop a running pipeline
 */
export function stopPipeline(workspace, repo, pipelineUuid) {
  return runCli(`stop-pipeline "${workspace}" "${repo}" "${pipelineUuid}"`);
}

/**
 * Monitor progress of a running pipeline
 * Returns current status and tail of logs for running steps
 */
export function monitorPipelineProgress(workspace, repo, pipelineUuid, tailLines = 40) {
  const bytesToFetch = tailLines * 80; // ~80 chars per line

  // Get all steps
  const steps = runCli(`get-pipeline-steps "${workspace}" "${repo}" "${pipelineUuid}"`);

  // Filter by status
  const runningSteps = steps.values?.filter(s => s.state?.name === "IN_PROGRESS") || [];
  const completedSteps = steps.values?.filter(s => s.state?.name === "COMPLETED") || [];
  const pendingSteps = steps.values?.filter(s => s.state?.name === "PENDING") || [];

  const progress = {
    total: steps.values?.length || 0,
    completed: completedSteps.length,
    running: runningSteps.length,
    pending: pendingSteps.length,
    runningDetails: []
  };

  // Get tail logs for running steps
  for (const step of runningSteps) {
    const logTail = runCliText(
      `tail-step-log "${workspace}" "${repo}" "${pipelineUuid}" "${step.uuid}" ${bytesToFetch}`
    );

    progress.runningDetails.push({
      stepName: step.name,
      stepUuid: step.uuid,
      startedOn: step.started_on,
      duration: step.duration_in_seconds || 0,
      logTail: logTail.trim().split('\n').slice(-tailLines).join('\n')
    });
  }

  return progress;
}

/**
 * Get current status of pipeline (simplified monitor)
 */
export function getCurrentPipelineStatus(workspace, repo, pipelineUuid) {
  return monitorPipelineProgress(workspace, repo, pipelineUuid, 20);
}
/**
 * Get branching model (available pipeline types)
 */
export function getBranchingModel(workspace, repo) {
  return runCli(`get-branching-model "${workspace}" "${repo}"`);
}

/**
 * List recent pipelines with optional filters
 */
export function listPipelines(workspace, repo, limit = 10, status = null) {
  const statusArg = status ? ` ${status}` : '';
  return runCli(`list-pipelines "${workspace}" "${repo}" ${limit}${statusArg}`);
}

// ============ GIT OPERATIONS ============

/**
 * Load credentials for git operations
 * Reads from same sources as CLI, returns credentials object
 */
function loadCredentials() {
  const credentialPaths = [
    join(process.cwd(), "credentials.json"),
    join(process.cwd(), ".bitbucket-credentials"),
    join(os.homedir(), ".bitbucket-credentials"),
    join(os.homedir(), ".claude", "skills", "bitbucket-devops", "credentials.json"),
  ];

  for (const credPath of credentialPaths) {
    if (fs.existsSync(credPath)) {
      try {
        const content = fs.readFileSync(credPath, "utf-8");
        return JSON.parse(content);
      } catch (error) {
        continue;
      }
    }
  }

  throw new Error('No credentials file found. Please create credentials.json from template.');
}

/**
 * Build authenticated git URL for HTTPS operations
 * Uses username (workspace slug) for git auth, not user_email
 * @param {string} workspace - Bitbucket workspace slug
 * @param {string} repo - Repository slug
 * @returns {string} Fully authenticated git URL
 */
export function buildGitUrl(workspace, repo) {
  const creds = loadCredentials();

  // Git operations use username (workspace slug), not user_email
  const gitUsername = creds.username;
  const password = creds.password || creds.app_password;

  if (!password) {
    throw new Error('Password/app-password required for git operations');
  }

  // URL-encode password for special characters
  const encodedPassword = encodeURIComponent(password);

  return `https://${gitUsername}:${encodedPassword}@bitbucket.org/${workspace}/${repo}.git`;
}

/**
 * Test git connectivity to a repository
 * @param {string} workspace - Bitbucket workspace slug
 * @param {string} repo - Repository slug
 * @returns {object} Result with success flag and commit hash or error
 */
export function testGitAuth(workspace, repo) {
  try {
    const gitUrl = buildGitUrl(workspace, repo);
    const result = execSync(`git ls-remote ${gitUrl} HEAD`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const commit = result.trim().split('\t')[0];
    return {
      success: true,
      commit,
      message: `Git authentication successful for ${workspace}/${repo}`
    };
  } catch (error) {
    return {
      success: false,
      error: error.stderr || error.message,
      message: `Git authentication failed for ${workspace}/${repo}`
    };
  }
}

/**
 * Clone a repository to a local directory
 * @param {string} workspace - Bitbucket workspace slug
 * @param {string} repo - Repository slug
 * @param {string} targetDir - Target directory (defaults to repo name)
 * @returns {object} Result with success flag and directory path
 */
export function cloneRepository(workspace, repo, targetDir = null) {
  try {
    const gitUrl = buildGitUrl(workspace, repo);
    const target = targetDir || repo;

    execSync(`git clone ${gitUrl} ${target}`, {
      encoding: 'utf-8',
      stdio: 'inherit'  // Show git output to user
    });

    return {
      success: true,
      directory: target,
      message: `Successfully cloned ${workspace}/${repo} to ${target}`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: `Failed to clone ${workspace}/${repo}`
    };
  }
}

// ============ DEPLOYMENT ENVIRONMENTS & VARIABLES ============
//
// Bitbucket Cloud REST API v2.0 supports creating/managing "Deployment
// environments" (Repository settings -> Pipelines -> Deployments) and their
// secured deployment variables, but the environments endpoints are NOT part
// of the official public API reference (confirmed via Atlassian Community -
// an Atlassian staffer stated the create-environment endpoint "is not yet
// documented"). The endpoints work in practice; treat exact field casing
// (e.g. "Test" vs "TEST") as something to verify with a read-only GET
// against the target repo before relying on it, since sources disagree.
//
// Required scope (Bitbucket app password, legacy scope model):
//   - Deployment variables: `pipeline:variable` ("Pipelines: Edit variables")
//     - explicitly documented by Atlassian.
//   - Environments (creating the environment object itself): NOT explicitly
//     documented anywhere. `pipeline:variable` / "Pipelines: Write" may be
//     sufficient since environments live under the Pipelines/Deployments
//     product area, but `repository:admin` ("Repositories: Admin") may be
//     required instead. This is unresolved from documentation alone -
//     the first create-environment call against a real repo will tell you
//     which is needed (expect 403 if the scope is insufficient).
//
// IMPORTANT - Bitbucket app passwords are being retired. Atlassian's
// deprecation notice describes an active "brownout" period (scheduled
// outage windows) leading up to FULL REMOVAL of app passwords. Check
// https://bitbucket.org/account/settings/app-passwords/ and Atlassian's
// announcement before depending on new app-password scopes long-term -
// API tokens (Atlassian account email + API token, Basic auth) are the
// forward-compatible replacement and should be used for any credential
// created or rotated from now on.

/**
 * Load API credentials (email + password/app-password) using the same
 * three-tier credential file convention as loadCredentials(), tolerant of
 * `email` as a fallback for `user_email` and `app_password` as a fallback
 * for `password` (both are also accepted by Tier 2's index-cli.js as of
 * the same fix, so Tier 1 and Tier 2 now agree on what counts as valid).
 * `user_email`/`password` are still the documented, preferred field names
 * per credentials.json.template.
 */
function loadApiCredentials() {
  const creds = loadCredentials();

  const email = creds.user_email || creds.email;
  const password = creds.password || creds.app_password;
  const baseUrl = (creds.url || creds.baseUrl || 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');

  if (!email) {
    throw new Error(
      "Credentials missing 'user_email' (required for Bitbucket API auth). " +
      "Add \"user_email\": \"you@example.com\" to your credentials file."
    );
  }
  if (!password) {
    throw new Error("Credentials missing 'password'/'app_password' (required for Bitbucket API auth).");
  }

  return { email, password, baseUrl };
}

/**
 * Diagnose which credential file is active and whether it's structurally
 * valid, WITHOUT ever returning or printing any secret value (password,
 * app_password, or token). Intended so a human (or an agent) can answer
 * "which credential are we using, and is it shaped right?" by running
 * this command, instead of ever needing to open/cat the file directly --
 * the exact mistake this command exists to prevent a repeat of.
 *
 * Reports: which path in the priority chain is active, which of the
 * accepted field-name aliases it uses, format-validity booleans (does
 * user_email/email look like an email, does username avoid containing
 * "@"), and whether the file would satisfy both Tier 1 and Tier 2's
 * requirements. workspace/username ARE included since Bitbucket treats
 * both as public identifiers (visible in every repo URL), not secrets --
 * password/app_password/token values are never included, not even
 * partially or hashed.
 */
export function checkCredentials() {
  const credentialPaths = [
    join(process.cwd(), 'credentials.json'),
    join(process.cwd(), '.bitbucket-credentials'),
    join(os.homedir(), '.bitbucket-credentials'),
    join(os.homedir(), '.claude', 'skills', 'bitbucket-devops', 'credentials.json'),
  ];

  for (const credPath of credentialPaths) {
    if (!fs.existsSync(credPath)) continue;

    let creds;
    try {
      creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    } catch (err) {
      return { path: credPath, parseable: false, error: String(err.message || err) };
    }

    const emailField = creds.user_email ? 'user_email' : (creds.email ? 'email' : null);
    const emailValue = creds.user_email || creds.email || null;
    const passwordField = creds.password ? 'password' : (creds.app_password ? 'app_password' : null);
    const usernameOk = !!creds.username && !creds.username.includes('@');

    return {
      path: credPath,
      parseable: true,
      workspace: creds.workspace || null,
      username: creds.username || null,
      hasWorkspace: !!creds.workspace,
      usernamePresent: !!creds.username,
      usernameContainsAt: !!creds.username && creds.username.includes('@'),
      emailFieldUsed: emailField, // which field name was actually found (not the preferred one necessarily)
      emailLooksValid: !!emailValue && emailValue.includes('@'),
      passwordFieldUsed: passwordField, // which field name was found; value itself never included
      hasToken: !!creds.token,
      tier1Ready: !!(emailField && emailValue && emailValue.includes('@') && passwordField),
      tier2Ready: !!(emailField && emailValue && emailValue.includes('@') && passwordField && usernameOk),
      recommendations: [
        ...(emailField === 'email' ? ["Rename 'email' to 'user_email' (documented field name)."] : []),
        ...(passwordField === 'app_password' ? ["Rename 'app_password' to 'password' (documented field name), and consider switching to an Atlassian API token -- app passwords are being deprecated."] : []),
        ...(!usernameOk && creds.username ? ["'username' contains '@' -- it must be your workspace slug, not an email address."] : []),
        ...(!emailField ? ["Add 'user_email' (your Bitbucket account email)."] : []),
        ...(!passwordField ? ["Add 'password' (an Atlassian API token or app password)."] : []),
      ],
    };
  }

  return { path: null, found: false, message: 'No credentials file found in any of the standard locations.' };
}

/**
 * Low-level authenticated Bitbucket API request (JSON in, JSON out).
 * Used only by the deployment environment/variable helpers below - all
 * other Tier 1 helpers go through the vendored bitbucket-mcp CLI instead.
 */
function bbApiRequest(method, pathname, body) {
  const { email, password, baseUrl } = loadApiCredentials();
  const target = new URL(baseUrl + pathname);
  const auth = Buffer.from(`${email}:${password}`).toString('base64');
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
  };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: target.hostname, path: target.pathname + target.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          let parsed = null;
          if (data) {
            try { parsed = JSON.parse(data); } catch { parsed = data; }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(
              `Bitbucket API error ${res.statusCode} for ${method} ${pathname}: ` +
              (typeof parsed === 'string' ? parsed : JSON.stringify(parsed))
            ));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Resolve an environment name or UUID to its UUID, by listing environments
 * and matching on `name` if the identifier doesn't already look like a UUID.
 */
async function resolveEnvironmentUuid(workspace, repo, identifier) {
  if (identifier.includes('{')) {
    return identifier;
  }
  const envs = await listEnvironments(workspace, repo);
  const match = envs.values?.find((e) => e.name === identifier);
  if (!match) {
    throw new Error(`Environment "${identifier}" not found in ${workspace}/${repo}. ` +
      `Available: ${envs.values?.map((e) => e.name).join(', ') || '(none)'}`);
  }
  return match.uuid;
}

/**
 * Resolve a variable key or UUID to its UUID, by listing variables for the
 * environment and matching on `key` if the identifier isn't already a UUID.
 */
async function resolveVariableUuid(workspace, repo, environmentUuid, identifier) {
  if (identifier.includes('{')) {
    return identifier;
  }
  const vars = await listDeployVariables(workspace, repo, environmentUuid);
  const match = vars.values?.find((v) => v.key === identifier);
  if (!match) {
    throw new Error(`Variable "${identifier}" not found in environment ${environmentUuid}. ` +
      `Available: ${vars.values?.map((v) => v.key).join(', ') || '(none)'}`);
  }
  return match.uuid;
}

/**
 * List deployment environments for a repository.
 * GET /2.0/repositories/{workspace}/{repo_slug}/environments/
 */
export function listEnvironments(workspace, repo) {
  return bbApiRequest('GET', `/repositories/${workspace}/${repo}/environments/`);
}

/**
 * Create a deployment environment (e.g. "sandbox", "production").
 * POST /2.0/repositories/{workspace}/{repo_slug}/environments/
 *
 * @param {string} name - Display name, e.g. "sandbox", "production"
 * @param {string} environmentType - Bitbucket's environment category:
 *   "Test", "Staging", or "Production" (affects deployment permissions/
 *   restrictions available in the UI). Defaults to "Test". Verify exact
 *   casing against a real GET response for your workspace if creation fails.
 * @param {number} rank - Sort order among environments (0-based). Optional.
 */
export function createEnvironment(workspace, repo, name, environmentType = 'Test', rank) {
  const body = {
    name,
    environment_type: { name: environmentType },
  };
  if (rank !== undefined && rank !== null) {
    body.rank = typeof rank === 'string' ? parseInt(rank, 10) : rank;
  }
  return bbApiRequest('POST', `/repositories/${workspace}/${repo}/environments/`, body);
}

/**
 * List deployment variables for an environment.
 * GET /2.0/repositories/{workspace}/{repo_slug}/deployments_config/environments/{environment_uuid}/variables/
 *
 * Note: values of secured (secured: true) variables are never returned once
 * set - this is documented Bitbucket UI/product behavior for secrets.
 */
export async function listDeployVariables(workspace, repo, environmentIdentifier) {
  const envUuid = await resolveEnvironmentUuid(workspace, repo, environmentIdentifier);
  return bbApiRequest('GET', `/repositories/${workspace}/${repo}/deployments_config/environments/${envUuid}/variables/`);
}

/**
 * Create a deployment variable in an environment.
 * POST /2.0/repositories/{workspace}/{repo_slug}/deployments_config/environments/{environment_uuid}/variables/
 *
 * @param {boolean} secured - Defaults to true. Set false only for genuinely
 *   non-secret values (e.g. an environment name/URL) - once created with
 *   secured: true, the value can only be replaced or deleted, never read back.
 */
export async function createDeployVariable(workspace, repo, environmentIdentifier, key, value, secured = true) {
  const envUuid = await resolveEnvironmentUuid(workspace, repo, environmentIdentifier);
  const body = { key, value, secured: secured === 'false' ? false : Boolean(secured) };
  return bbApiRequest('POST', `/repositories/${workspace}/${repo}/deployments_config/environments/${envUuid}/variables/`, body);
}

/**
 * Update an existing deployment variable (by key or UUID).
 * PUT /2.0/repositories/{workspace}/{repo_slug}/deployments_config/environments/{environment_uuid}/variables/{variable_uuid}
 *
 * Pass only the fields you want to change; existing key/secured are reused
 * when omitted (value must always be supplied - Bitbucket does not support
 * a partial PATCH here).
 */
export async function updateDeployVariable(workspace, repo, environmentIdentifier, variableIdentifier, { key, value, secured } = {}) {
  const envUuid = await resolveEnvironmentUuid(workspace, repo, environmentIdentifier);
  const varUuid = await resolveVariableUuid(workspace, repo, envUuid, variableIdentifier);
  const body = { uuid: varUuid };
  if (key !== undefined) body.key = key;
  if (value !== undefined) body.value = value;
  if (secured !== undefined) body.secured = secured === 'false' ? false : Boolean(secured);
  return bbApiRequest('PUT', `/repositories/${workspace}/${repo}/deployments_config/environments/${envUuid}/variables/${varUuid}`, body);
}

/**
 * Delete a deployment variable (by key or UUID).
 * DELETE /2.0/repositories/{workspace}/{repo_slug}/deployments_config/environments/{environment_uuid}/variables/{variable_uuid}
 */
export async function deleteDeployVariable(workspace, repo, environmentIdentifier, variableIdentifier) {
  const envUuid = await resolveEnvironmentUuid(workspace, repo, environmentIdentifier);
  const varUuid = await resolveVariableUuid(workspace, repo, envUuid, variableIdentifier);
  await bbApiRequest('DELETE', `/repositories/${workspace}/${repo}/deployments_config/environments/${envUuid}/variables/${varUuid}`);
  return { success: true, message: `Deleted variable ${variableIdentifier} from environment ${environmentIdentifier}` };
}

// CLI entry point
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);

  (async () => {
  try {
    let result;

    switch (command) {
      case 'get-latest-failed':
        result = getLatestFailedPipeline(args[0], args[1]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'get-latest':
        result = getLatestPipeline(args[0], args[1]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'get-by-number':
        result = getPipelineByNumber(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'get-failed-steps':
        result = getFailedSteps(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'download-failed-logs':
        result = downloadFailedStepLogs(args[0], args[1], args[2], args[3]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'get-info':
        result = getPipelineInfo(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;


      case 'stop-pipeline':
        result = stopPipeline(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'monitor-progress':
        result = monitorPipelineProgress(args[0], args[1], args[2], args[3] ? parseInt(args[3]) : 40);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'current-status':
        result = getCurrentPipelineStatus(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'test-git-auth':
        result = testGitAuth(args[0], args[1]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'check-credentials':
        result = checkCredentials();
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'clone-repo':
        result = cloneRepository(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'list-environments':
        result = await listEnvironments(args[0], args[1]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'create-environment':
        result = await createEnvironment(args[0], args[1], args[2], args[3], args[4]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'list-deploy-variables':
        result = await listDeployVariables(args[0], args[1], args[2]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'create-deploy-variable':
        result = await createDeployVariable(args[0], args[1], args[2], args[3], args[4], args[5]);
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'update-deploy-variable':
        // args: workspace repo environment variable [key] [value] [secured]
        result = await updateDeployVariable(args[0], args[1], args[2], args[3], {
          key: args[4] || undefined,
          value: args[5] !== undefined ? args[5] : undefined,
          secured: args[6] !== undefined ? args[6] : undefined,
        });
        console.log(JSON.stringify(result, null, 2));
        break;

      case 'delete-deploy-variable':
        result = await deleteDeployVariable(args[0], args[1], args[2], args[3]);
        console.log(JSON.stringify(result, null, 2));
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('\nAvailable commands:');
        console.error('  Pipeline commands:');
        console.error('    get-latest-failed <workspace> <repo>');
        console.error('    get-latest <workspace> <repo>');
        console.error('    get-by-number <workspace> <repo> <build_number>');
        console.error('    get-failed-steps <workspace> <repo> <pipeline_uuid>');
        console.error('    download-failed-logs <workspace> <repo> <pipeline_uuid> <build_number>');
        console.error('    get-info <workspace> <repo> <pipeline_uuid>');
        console.error('    stop-pipeline <workspace> <repo> <pipeline_uuid>');
        console.error('    monitor-progress <workspace> <repo> <pipeline_uuid> [tail_lines]');
        console.error('    current-status <workspace> <repo> <pipeline_uuid>');
        console.error('');
        console.error('  Git commands:');
        console.error('    test-git-auth <workspace> <repo>');
        console.error('    clone-repo <workspace> <repo> [target_dir]');
        console.error('');
        console.error('  Credential diagnostics:');
        console.error('    check-credentials   -- reports which credential file is active and');
        console.error('                            whether it is shaped correctly, WITHOUT ever');
        console.error('                            printing any secret value. Run this instead of');
        console.error('                            opening/catting a credentials file directly.');
        console.error('');
        console.error('  Deployment environment/variable commands:');
        console.error('    list-environments <workspace> <repo>');
        console.error('    create-environment <workspace> <repo> <name> [environment_type=Test] [rank]');
        console.error('    list-deploy-variables <workspace> <repo> <environment_name_or_uuid>');
        console.error('    create-deploy-variable <workspace> <repo> <environment_name_or_uuid> <key> <value> [secured=true]');
        console.error('    update-deploy-variable <workspace> <repo> <environment_name_or_uuid> <variable_key_or_uuid> [key] [value] [secured]');
        console.error('    delete-deploy-variable <workspace> <repo> <environment_name_or_uuid> <variable_key_or_uuid>');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
  })();
}
