/** Explicit read-only entry point. The second file contains trusted host requirements. */
import { readFileSync } from 'fs';
import { emulatorGate, preflightGate, providerGate, releaseGate, scopeGate } from './gates';

export function main(args: string[]): number {
  try {
    const [mode, observationFile, requirementsFile] = args;
    if (args.length !== 3) throw new Error('usage');
    const observations = JSON.parse(readFileSync(observationFile,'utf8').replace(/^\uFEFF/,''));
    const requirements = JSON.parse(readFileSync(requirementsFile,'utf8').replace(/^\uFEFF/,''));
    let result;
    switch (mode) {
      case 'preflight': result = preflightGate(observations,requirements); break;
      case 'release': result = releaseGate(observations,requirements); break;
      case 'provider': result = providerGate(observations,requirements); break;
      case 'emulator': result = emulatorGate(observations,requirements); break;
      case 'scope':
        // Do not take allowlists/roadmap baselines from untrusted observations.
        result = scopeGate({...requirements,changedRealPaths:observations.changedRealPaths,
          roadmaps:requirements.roadmaps.map((r: {path:string; before:string}) => ({...r,after:observations.roadmapHashes[r.path]}))});
        break;
      default: throw new Error('usage');
    }
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    return result.verdict === 'PASS' ? 0 : 1;
  } catch {
    // Never echo raw input, stack traces, tokens or connection URLs.
    process.stdout.write(JSON.stringify({verdict:'BLOCKED',reasons:['INVALID_INPUT_OR_UNREADABLE_FILE'],
      usage:'ts-node src/standards/cli.ts preflight|release|provider|emulator|scope observations.json trusted-requirements.json'})+'\n');
    return 1;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
