import { ParsedArgs } from "../cli/parse-args";
import { formatGuardianReviewSummary, GuardianReviewError, runGuardianReview } from "../guardian/evidence-gate";
import { error } from "../utils/logger";

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" ? value : undefined;
}

export async function guardianReviewCommand(args: ParsedArgs): Promise<number> {
  try {
    const review = await runGuardianReview({
      reviewId: stringFlag(args, "review") ?? "",
      workerJobId: stringFlag(args, "job") ?? "",
    });
    process.stdout.write(formatGuardianReviewSummary(review));
    return review.verdict === "PASS" || review.verdict === "WARN" ? 0 : 1;
  } catch (err) {
    if (err instanceof GuardianReviewError) {
      error(`[amon guardian-review] ${err.message}`);
      return 1;
    }
    error(`[amon guardian-review] ${(err as Error).message}`);
    return 1;
  }
}
