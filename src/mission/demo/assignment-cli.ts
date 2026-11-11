#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { Capability } from '../capabilities';
import { Action } from '../contracts';
import { proposeAssignment, renderAssignmentProposal } from '../assignment-proposal';
import { fixture } from './fixtures';

if (process.argv.length !== 2) { process.stderr.write('Uso: npm run demo:assignment\n'); process.exitCode = 2; }
else {
  process.stdout.write('001C — Comparación real de capacidades; planes de prueba simulados. No ejecuta agentes.\n');
  const cases: [Capability[], Action, string][] = [
    [['architecture-plan'], 'diagnose', 'architect'], [['security-review'], 'verify', 'security'],
    [['plan-qa'], 'verify', 'qa'], [['readiness-assessment'], 'diagnose', 'ops'],
    [['ui-design'], 'design', 'NO_CAPABLE_AGENT'], [['code-implementation'], 'implement', 'NO_CAPABLE_AGENT'],
    [['plan-review'], 'verify', 'AMBIGUOUS_CAPABILITIES'],
  ];
  for (const [requiredCapabilities, action, expected] of cases) {
    const {m} = fixture();
    m.authorizationPolicy.allowedActions = [action]; m.assignments[0].allowedActions = [action];
    const proposal = proposeAssignment(m, {assignmentId: 'architect', action, requiredCapabilities},
      {repositoryAliases: [m.repositoryAlias], allowedActions: [action]});
    assert.equal(proposal.proposedRole || proposal.errors[0], expected);
    process.stdout.write('\n' + renderAssignmentProposal(proposal) + '\n');
  }
}
