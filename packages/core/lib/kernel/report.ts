import type { KernelWorkItem } from "./internal";
import { describeNode, getInspectorScopeId, readInspectorNodeMeta } from "./inspector";

// Single funnel for failures the graph contains rather than propagates.
//
// The rule (uniform for sync and async, matching ordinary async JS): a throwing
// observer stops ITS OWN branch — nothing downstream of it runs — independent
// branches of the same update still complete, and whoever awaits the trigger
// gets the rejection. The failure is never swallowed silently.
//
// The default report has to be readable straight from a console with no devtools
// attached: what failed, where it was declared, in which scope, and the exact
// chain of units that led there.

/** A contained failure, as handed to a custom reporter. */
export interface VirentiaFailureReport {
  /** What kind of observer failed: `reaction`, `async reaction`, `store subscriber`. */
  kind: string;
  /** The failing unit, e.g. `reaction "connectSocket"`. */
  unit: string;
  /** Where the unit was declared, when the site could be captured. */
  declaredAt?: string;
  /** Identifier of the scope the update ran in. */
  scope?: string;
  /** Units the update travelled through, source first, failing unit last. */
  path: string[];
  /** The value that was thrown, untouched. */
  error: unknown;
  /** The default human-readable report, ready to print. */
  message: string;
}

export type VirentiaErrorReporter = (failure: VirentiaFailureReport) => void;

// Errors already delivered through the reporter. A detached (fire-and-forget)
// launch absorbs these instead of crashing the process with an unhandled
// rejection; an error NOT in this set has never been seen and must be reported
// by whoever absorbs it. Primitive throws can't be tracked — they read as
// unreported, which at worst duplicates a report rather than losing one.
const reportedErrors = new WeakSet<object>();

export function markErrorReported(error: unknown): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    reportedErrors.add(error as object);
  }
}

export function wasErrorReported(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    reportedErrors.has(error as object)
  );
}

export interface ContainedFailure {
  kind: string;
  item?: KernelWorkItem;
  subject?: string;
  scopeLabel?: string;
}

const defaultReporter: VirentiaErrorReporter = (failure) => {
  // The Error object is passed through untouched so the console keeps its stack
  // and its "click to open" source links.
  // eslint-disable-next-line no-console
  console.error(failure.message, failure.error);
};

let reporter: VirentiaErrorReporter = defaultReporter;

/**
 * Replaces where contained failures are sent — a crash reporter, a structured
 * logger, a test spy. Pass `null` to restore the default console report.
 *
 * A reporter that throws does not take the update down: the default report is
 * used as a fallback so the failure is still visible.
 */
export function setErrorReporter(next: VirentiaErrorReporter | null): void {
  reporter = next ?? defaultReporter;
}

function propagationPath(item: KernelWorkItem): string[] {
  const path: string[] = [];

  for (let cursor: KernelWorkItem | undefined = item; cursor; cursor = cursor.parent) {
    // Internal plumbing (invalidator nodes, effect sub-units) is noise to
    // someone reading a stack trace — keep the units they actually wrote.
    if (!readInspectorNodeMeta(cursor.node).internal) {
      path.unshift(describeNode(cursor.node));
    }

    // Defensive: a malformed parent cycle must not hang the error path.
    if (path.length > 32) {
      path.unshift("…");
      break;
    }
  }

  return path;
}

export function reportContainedError(error: unknown, failure: ContainedFailure): void {
  markErrorReported(error);

  const unit = failure.subject ?? (failure.item ? describeNode(failure.item.node) : "a unit");
  const declaredAt = failure.item ? readInspectorNodeMeta(failure.item.node).loc : undefined;
  const scope =
    failure.scopeLabel ??
    (failure.item?.scope ? getInspectorScopeId(failure.item.scope) : undefined);
  const path = failure.item ? propagationPath(failure.item) : [];

  const lines = [`[virentia] ${failure.kind} failed: ${unit}`];

  if (typeof declaredAt === "string") lines.push(`  declared at: ${declaredAt}`);
  if (scope) lines.push(`  scope: ${scope}`);
  if (path.length > 1) lines.push(`  propagation path: ${path.join(" → ")}`);

  lines.push("  this branch stopped here; independent branches of the same update still ran");
  lines.push("  the update as a whole fails, so an awaited trigger will reject with this error");

  const report: VirentiaFailureReport = {
    kind: failure.kind,
    unit,
    declaredAt: typeof declaredAt === "string" ? declaredAt : undefined,
    scope,
    path,
    error,
    message: lines.join("\n"),
  };

  try {
    reporter(report);
  } catch {
    // A reporter that throws must not take down the update it was reporting on.
    if (reporter !== defaultReporter) defaultReporter(report);
  }
}
